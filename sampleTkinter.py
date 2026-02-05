"""
Tkinter Pivot Table Builder (with rail grouping)

Features
- Pick Base Directory, Start Keyword, Output Directory, Output File Name
- Loads reports (CSV) from folders under base_dir that start with keyword
- Values / Index / Columns multi-select with checkbuttons
  - Mutual exclusion across the three buckets
  - Selection order determines field order
- aggfunc dropdown
- Rail grouping tool:
  - Reads unique df["rail"] values
  - Search + multi-select + Select All
  - Assign selected rails to a group name (new or existing)
  - Removes assigned rails from list until all assigned
  - Shows mapping "rail_value => group_name"
  - Applies mapping by replacing df["rail"] with group names before pivot

Dataset columns expected:
block, state, voltage, rail, corner, dynamic, leakage, total
"""

import os
import glob
import tkinter as tk
from tkinter import ttk, filedialog, messagebox, simpledialog
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set, Tuple

import pandas as pd


DF_COLUMNS = ["block", "state", "voltage", "rail", "corner", "dynamic", "leakage", "total"]
PIVOT_CHOICES = DF_COLUMNS[:]  # the checkbutton options


def read_reports_from_folders(base_dir: str, start_keyword: str) -> pd.DataFrame:
    """
    Collects CSV files from folders directly under base_dir that start with start_keyword.
    Then concatenates into one dataframe.
    """
    if not os.path.isdir(base_dir):
        raise FileNotFoundError(f"Base directory not found: {base_dir}")

    folders = []
    for name in os.listdir(base_dir):
        full = os.path.join(base_dir, name)
        if os.path.isdir(full) and name.startswith(start_keyword):
            folders.append(full)

    if not folders:
        raise FileNotFoundError(
            f"No folders found under '{base_dir}' starting with keyword '{start_keyword}'."
        )

    csv_files: List[str] = []
    for f in folders:
        csv_files.extend(glob.glob(os.path.join(f, "**", "*.csv"), recursive=True))

    if not csv_files:
        raise FileNotFoundError(
            f"Found {len(folders)} folder(s) but no CSV files inside them."
        )

    dfs = []
    errors = []
    for path in csv_files:
        try:
            df = pd.read_csv(path)
            dfs.append(df)
        except Exception as e:
            errors.append((path, str(e)))

    if not dfs:
        msg = "All CSV reads failed.\n\n" + "\n".join([f"{p}: {err}" for p, err in errors[:10]])
        raise RuntimeError(msg)

    df_all = pd.concat(dfs, ignore_index=True)

    # Optional: keep only expected columns if present
    # If your CSVs have extra columns, they are preserved. If missing, we warn later.
    return df_all


@dataclass
class SelectionState:
    values: List[str] = field(default_factory=list)
    index: List[str] = field(default_factory=list)
    columns: List[str] = field(default_factory=list)

    def bucket_of(self, field_name: str) -> Optional[str]:
        if field_name in self.values:
            return "values"
        if field_name in self.index:
            return "index"
        if field_name in self.columns:
            return "columns"
        return None

    def remove_from_all(self, field_name: str) -> None:
        if field_name in self.values:
            self.values.remove(field_name)
        if field_name in self.index:
            self.index.remove(field_name)
        if field_name in self.columns:
            self.columns.remove(field_name)

    def add_to_bucket(self, bucket: str, field_name: str) -> None:
        self.remove_from_all(field_name)
        lst = getattr(self, bucket)
        lst.append(field_name)

    def ordered_tuple(self) -> Tuple[List[str], List[str], List[str]]:
        return (self.values[:], self.index[:], self.columns[:])


class PivotBuilderApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Pivot Table Builder")
        self.geometry("1120x720")

        self.df: Optional[pd.DataFrame] = None

        # Rail grouping mapping: original rail value -> group name
        self.rail_to_group: Dict[str, str] = {}

        # Group names created
        self.group_names: List[str] = []

        # Selection state for pivot
        self.sel_state = SelectionState()

        # Tk variables
        self.base_dir_var = tk.StringVar()
        self.keyword_var = tk.StringVar()
        self.output_dir_var = tk.StringVar()
        self.file_name_var = tk.StringVar(value="pivot_output")

        self.aggfunc_var = tk.StringVar(value="sum")

        # For checkbutton variables per bucket
        self.values_vars: Dict[str, tk.BooleanVar] = {}
        self.index_vars: Dict[str, tk.BooleanVar] = {}
        self.columns_vars: Dict[str, tk.BooleanVar] = {}

        # Disabled states for cross-bucket mutual exclusion
        self.values_checks: Dict[str, ttk.Checkbutton] = {}
        self.index_checks: Dict[str, ttk.Checkbutton] = {}
        self.columns_checks: Dict[str, ttk.Checkbutton] = {}

        self._build_ui()

    # ---------------- UI ----------------
    def _build_ui(self):
        outer = ttk.Frame(self, padding=10)
        outer.pack(fill="both", expand=True)

        top = ttk.LabelFrame(outer, text="1) Paths and Output", padding=10)
        top.pack(fill="x")

        # Base dir
        ttk.Label(top, text="Base directory:").grid(row=0, column=0, sticky="w")
        ttk.Entry(top, textvariable=self.base_dir_var, width=70).grid(row=0, column=1, sticky="w", padx=6)
        ttk.Button(top, text="Browse", command=self._pick_base_dir).grid(row=0, column=2, padx=6)

        # Keyword
        ttk.Label(top, text="Start keyword:").grid(row=1, column=0, sticky="w")
        ttk.Entry(top, textvariable=self.keyword_var, width=30).grid(row=1, column=1, sticky="w", padx=6)

        # Output dir
        ttk.Label(top, text="Output directory:").grid(row=2, column=0, sticky="w")
        ttk.Entry(top, textvariable=self.output_dir_var, width=70).grid(row=2, column=1, sticky="w", padx=6)
        ttk.Button(top, text="Browse", command=self._pick_output_dir).grid(row=2, column=2, padx=6)

        # File name
        ttk.Label(top, text="File name (csv):").grid(row=3, column=0, sticky="w")
        ttk.Entry(top, textvariable=self.file_name_var, width=30).grid(row=3, column=1, sticky="w", padx=6)

        # Load + Create buttons
        ttk.Button(top, text="Load Reports to DataFrame", command=self._load_df).grid(row=0, column=3, padx=10)
        ttk.Button(top, text="Create Pivot and Export CSV", command=self._create_pivot).grid(row=2, column=3, padx=10)

        for r in range(4):
            top.grid_rowconfigure(r, pad=6)

        mid = ttk.Frame(outer)
        mid.pack(fill="both", expand=True, pady=10)

        left = ttk.Frame(mid)
        left.pack(side="left", fill="both", expand=True)

        right = ttk.Frame(mid)
        right.pack(side="right", fill="both", expand=True, padx=(10, 0))

        # Pivot selector
        pivot_box = ttk.LabelFrame(left, text="2) Pivot Fields (mutually exclusive, ordered by click)", padding=10)
        pivot_box.pack(fill="both", expand=True)

        buckets = ttk.Frame(pivot_box)
        buckets.pack(fill="both", expand=True)

        self._build_bucket(buckets, "Values", 0)
        self._build_bucket(buckets, "Index", 1)
        self._build_bucket(buckets, "Columns", 2)

        # Aggfunc
        agg_box = ttk.Frame(pivot_box)
        agg_box.pack(fill="x", pady=(8, 0))
        ttk.Label(agg_box, text="aggfunc:").pack(side="left")

        agg_opts = ["sum", "mean", "min", "max", "count", "size", "std", "var", "median", "first", "last"]
        ttk.OptionMenu(agg_box, self.aggfunc_var, self.aggfunc_var.get(), *agg_opts).pack(side="left", padx=6)

        # Show ordered selection
        self.selection_preview = tk.Text(pivot_box, height=6, width=60)
        self.selection_preview.pack(fill="x", pady=(10, 0))
        self.selection_preview.configure(state="disabled")
        self._refresh_selection_preview()

        # Rail grouping
        group_box = ttk.LabelFrame(right, text='3) Rail Grouping (df["rail"])', padding=10)
        group_box.pack(fill="both", expand=True)

        search_row = ttk.Frame(group_box)
        search_row.pack(fill="x")

        ttk.Label(search_row, text="Search:").pack(side="left")
        self.rail_search_var = tk.StringVar()
        self.rail_search_var.trace_add("write", lambda *_: self._refresh_rail_list())
        ttk.Entry(search_row, textvariable=self.rail_search_var, width=30).pack(side="left", padx=6)

        ttk.Button(search_row, text="Load rail list from DF", command=self._init_rail_list_from_df).pack(side="left", padx=6)

        list_row = ttk.Frame(group_box)
        list_row.pack(fill="both", expand=True, pady=(10, 0))

        self.rail_listbox = tk.Listbox(list_row, selectmode=tk.EXTENDED)
        self.rail_listbox.pack(side="left", fill="both", expand=True)

        sb = ttk.Scrollbar(list_row, orient="vertical", command=self.rail_listbox.yview)
        sb.pack(side="left", fill="y")
        self.rail_listbox.config(yscrollcommand=sb.set)

        btn_col = ttk.Frame(list_row)
        btn_col.pack(side="left", fill="y", padx=10)

        ttk.Button(btn_col, text="Select All", command=self._select_all_rails).pack(fill="x", pady=2)
        ttk.Button(btn_col, text="Clear Selection", command=self._clear_rail_selection).pack(fill="x", pady=2)
        ttk.Button(btn_col, text="Assign to Group", command=self._assign_selected_rails_to_group).pack(fill="x", pady=10)
        ttk.Button(btn_col, text="Reset Grouping", command=self._reset_grouping).pack(fill="x", pady=2)

        mapping_box = ttk.LabelFrame(group_box, text="Assigned mapping (rail => group)", padding=8)
        mapping_box.pack(fill="both", expand=True, pady=(10, 0))

        self.mapping_listbox = tk.Listbox(mapping_box)
        self.mapping_listbox.pack(fill="both", expand=True)

        # Bottom status
        self.status_var = tk.StringVar(value="Ready.")
        ttk.Label(outer, textvariable=self.status_var).pack(anchor="w", pady=(8, 0))

        # Initialize checkbox vars and widgets
        self._init_checkboxes()

    def _build_bucket(self, parent: ttk.Frame, title: str, col: int):
        frame = ttk.LabelFrame(parent, text=title, padding=8)
        frame.grid(row=0, column=col, sticky="nsew", padx=6)

        parent.grid_columnconfigure(col, weight=1)
        parent.grid_rowconfigure(0, weight=1)

        inner = ttk.Frame(frame)
        inner.pack(fill="both", expand=True)

        # Store a reference to container for later population
        setattr(self, f"{title.lower()}_container", inner)

    def _init_checkboxes(self):
        # Create checkbuttons for each bucket for all choices.
        # We keep them all, but enforce mutual exclusion by disabling the same field in other buckets.
        for field in PIVOT_CHOICES:
            self.values_vars[field] = tk.BooleanVar(value=False)
            self.index_vars[field] = tk.BooleanVar(value=False)
            self.columns_vars[field] = tk.BooleanVar(value=False)

        # Place the widgets
        self._place_bucket_checks(
            container=self.values_container, bucket="values",
            vars_map=self.values_vars, checks_map=self.values_checks
        )
        self._place_bucket_checks(
            container=self.index_container, bucket="index",
            vars_map=self.index_vars, checks_map=self.index_checks
        )
        self._place_bucket_checks(
            container=self.columns_container, bucket="columns",
            vars_map=self.columns_vars, checks_map=self.columns_checks
        )

    def _place_bucket_checks(self, container: ttk.Frame, bucket: str,
                             vars_map: Dict[str, tk.BooleanVar],
                             checks_map: Dict[str, ttk.Checkbutton]):
        for w in container.winfo_children():
            w.destroy()

        for i, field in enumerate(PIVOT_CHOICES):
            cb = ttk.Checkbutton(
                container,
                text=field,
                variable=vars_map[field],
                command=lambda f=field, b=bucket: self._on_bucket_toggle(b, f)
            )
            cb.grid(row=i // 2, column=i % 2, sticky="w", padx=4, pady=2)
            checks_map[field] = cb

        container.grid_columnconfigure(0, weight=1)
        container.grid_columnconfigure(1, weight=1)

    # ---------------- Handlers ----------------
    def _pick_base_dir(self):
        d = filedialog.askdirectory()
        if d:
            self.base_dir_var.set(d)

    def _pick_output_dir(self):
        d = filedialog.askdirectory()
        if d:
            self.output_dir_var.set(d)

    def _set_status(self, msg: str):
        self.status_var.set(msg)
        self.update_idletasks()

    def _load_df(self):
        base = self.base_dir_var.get().strip()
        kw = self.keyword_var.get().strip()

        if not base:
            messagebox.showerror("Missing", "Please select a Base directory.")
            return
        if not kw:
            messagebox.showerror("Missing", "Please enter Start keyword.")
            return

        try:
            self._set_status("Loading reports into dataframe...")
            df = read_reports_from_folders(base, kw)

            missing = [c for c in DF_COLUMNS if c not in df.columns]
            if missing:
                messagebox.showwarning(
                    "Missing columns",
                    "These expected columns were not found in the loaded dataframe:\n\n"
                    + ", ".join(missing)
                    + "\n\nYou can still proceed if your pivot fields exist."
                )

            self.df = df
            self._set_status(f"Loaded DF: {len(df):,} rows, {len(df.columns)} columns.")
            messagebox.showinfo("Loaded", f"Loaded dataframe with {len(df):,} rows.")

        except Exception as e:
            self.df = None
            self._set_status("Load failed.")
            messagebox.showerror("Load failed", str(e))

    def _on_bucket_toggle(self, bucket: str, field_name: str):
        """
        - If checked in this bucket:
          - add to selection order list for this bucket
          - disable this field in the other two buckets
        - If unchecked:
          - remove from selection lists
          - re-enable in other buckets
        """
        vars_map = {
            "values": self.values_vars,
            "index": self.index_vars,
            "columns": self.columns_vars,
        }[bucket]

        checked = vars_map[field_name].get()

        if checked:
            # Remove from other buckets vars if they were checked there (safety)
            for other in ("values", "index", "columns"):
                if other == bucket:
                    continue
                other_vars = {"values": self.values_vars, "index": self.index_vars, "columns": self.columns_vars}[other]
                if other_vars[field_name].get():
                    other_vars[field_name].set(False)

            # Update ordered selection
            self.sel_state.add_to_bucket(bucket, field_name)

            # Disable in other buckets
            self._set_field_enabled_in_bucket("values", field_name, bucket == "values")
            self._set_field_enabled_in_bucket("index", field_name, bucket == "index")
            self._set_field_enabled_in_bucket("columns", field_name, bucket == "columns")

        else:
            # Remove from ordered selection
            self.sel_state.remove_from_all(field_name)

            # Re-enable in all buckets
            self._set_field_enabled_in_bucket("values", field_name, True)
            self._set_field_enabled_in_bucket("index", field_name, True)
            self._set_field_enabled_in_bucket("columns", field_name, True)

            # Ensure only the current bucket var stays false (others already false)
            # No extra action needed.

        self._refresh_selection_preview()

    def _set_field_enabled_in_bucket(self, bucket: str, field_name: str, enabled: bool):
        checks_map = {"values": self.values_checks, "index": self.index_checks, "columns": self.columns_checks}[bucket]
        cb = checks_map[field_name]
        cb.state(["!disabled"] if enabled else ["disabled"])

    def _refresh_selection_preview(self):
        v, i, c = self.sel_state.ordered_tuple()
        text = (
            f"Values (ordered): {v}\n"
            f"Index (ordered):  {i}\n"
            f"Columns (ordered): {c}\n"
        )

        self.selection_preview.configure(state="normal")
        self.selection_preview.delete("1.0", "end")
        self.selection_preview.insert("end", text)
        self.selection_preview.configure(state="disabled")

    # ---------------- Rail grouping ----------------
    def _init_rail_list_from_df(self):
        if self.df is None:
            messagebox.showerror("No DF", "Load the dataframe first.")
            return
        if "rail" not in self.df.columns:
            messagebox.showerror("Missing column", 'Dataframe does not contain column "rail".')
            return

        unique_rails = sorted([str(x) for x in self.df["rail"].dropna().unique().tolist()])
        if not unique_rails:
            messagebox.showwarning("Empty", 'No non-empty values found in df["rail"].')
            return

        # Reset only the available list, keep mapping as-is unless user resets
        self.all_rails: List[str] = unique_rails
        self.available_rails: List[str] = [r for r in unique_rails if r not in self.rail_to_group]
        self._refresh_rail_list()
        self._refresh_mapping_list()
        self._set_status(f'Loaded {len(unique_rails)} unique rails. Unassigned: {len(self.available_rails)}.')

    def _refresh_rail_list(self):
        if not hasattr(self, "available_rails"):
            self.available_rails = []

        q = self.rail_search_var.get().strip().lower()
        if q:
            display = [r for r in self.available_rails if q in r.lower()]
        else:
            display = self.available_rails[:]

        self.rail_listbox.delete(0, "end")
        for r in display:
            self.rail_listbox.insert("end", r)

    def _select_all_rails(self):
        self.rail_listbox.select_set(0, "end")

    def _clear_rail_selection(self):
        self.rail_listbox.selection_clear(0, "end")

    def _refresh_mapping_list(self):
        self.mapping_listbox.delete(0, "end")
        for rail_val in sorted(self.rail_to_group.keys()):
            self.mapping_listbox.insert("end", f"{rail_val} => {self.rail_to_group[rail_val]}")

    def _assign_selected_rails_to_group(self):
        if not hasattr(self, "available_rails"):
            messagebox.showerror("Not ready", "Load rail list from DF first.")
            return

        # Get selected displayed rails
        selected_idx = self.rail_listbox.curselection()
        if not selected_idx:
            messagebox.showwarning("No selection", "Select one or more rails to group.")
            return

        selected_vals = [self.rail_listbox.get(i) for i in selected_idx]

        # Ask group name: either choose existing or create new
        group_name = self._ask_group_name()
        if not group_name:
            return

        # Apply mapping
        for rail_val in selected_vals:
            self.rail_to_group[rail_val] = group_name

        # Remove from available
        selected_set = set(selected_vals)
        self.available_rails = [r for r in self.available_rails if r not in selected_set]

        self._refresh_rail_list()
        self._refresh_mapping_list()

        if not self.available_rails:
            self._set_status("All rails assigned to groups.")
            messagebox.showinfo("Done", "All rail values have been assigned to groups.")
        else:
            self._set_status(f"Assigned {len(selected_vals)} rail(s) to '{group_name}'. Remaining: {len(self.available_rails)}.")

    def _ask_group_name(self) -> Optional[str]:
        """
        Dialog that allows:
        - Create a new group name
        - Or select existing group name
        """
        dialog = tk.Toplevel(self)
        dialog.title("Select or Create Group")
        dialog.geometry("420x300")
        dialog.transient(self)
        dialog.grab_set()

        choice_var = tk.StringVar(value="new")
        ttk.Radiobutton(dialog, text="Create new group", variable=choice_var, value="new").pack(anchor="w", padx=10, pady=(10, 2))
        ttk.Radiobutton(dialog, text="Use existing group", variable=choice_var, value="existing").pack(anchor="w", padx=10, pady=2)

        new_name_var = tk.StringVar()
        new_row = ttk.Frame(dialog)
        new_row.pack(fill="x", padx=10, pady=8)
        ttk.Label(new_row, text="New group name:").pack(side="left")
        ttk.Entry(new_row, textvariable=new_name_var).pack(side="left", fill="x", expand=True, padx=6)

        ttk.Label(dialog, text="Existing groups:").pack(anchor="w", padx=10, pady=(8, 2))

        existing_lb = tk.Listbox(dialog, height=8)
        existing_lb.pack(fill="both", expand=True, padx=10)
        for g in self.group_names:
            existing_lb.insert("end", g)

        result = {"name": None}

        def on_ok():
            mode = choice_var.get()
            if mode == "new":
                name = new_name_var.get().strip()
                if not name:
                    messagebox.showerror("Missing", "Enter a new group name.", parent=dialog)
                    return
                if name not in self.group_names:
                    self.group_names.append(name)
                result["name"] = name
            else:
                sel = existing_lb.curselection()
                if not sel:
                    messagebox.showerror("Missing", "Select an existing group.", parent=dialog)
                    return
                result["name"] = existing_lb.get(sel[0])
            dialog.destroy()

        def on_cancel():
            dialog.destroy()

        btns = ttk.Frame(dialog)
        btns.pack(fill="x", padx=10, pady=10)
        ttk.Button(btns, text="OK", command=on_ok).pack(side="right", padx=6)
        ttk.Button(btns, text="Cancel", command=on_cancel).pack(side="right")

        self.wait_window(dialog)
        return result["name"]

    def _reset_grouping(self):
        self.rail_to_group.clear()
        self.group_names.clear()
        if hasattr(self, "all_rails"):
            self.available_rails = self.all_rails[:]
        else:
            self.available_rails = []
        self._refresh_rail_list()
        self._refresh_mapping_list()
        self._set_status("Grouping reset.")

    # ---------------- Pivot creation ----------------
    def _create_pivot(self):
        if self.df is None:
            messagebox.showerror("No DF", "Load the dataframe first.")
            return

        out_dir = self.output_dir_var.get().strip()
        if not out_dir:
            messagebox.showerror("Missing", "Select an Output directory.")
            return
        if not os.path.isdir(out_dir):
            messagebox.showerror("Invalid", f"Output directory not found: {out_dir}")
            return

        fname = self.file_name_var.get().strip()
        if not fname:
            messagebox.showerror("Missing", "Enter output file name.")
            return
        if not fname.lower().endswith(".csv"):
            fname = fname + ".csv"

        values, index, columns = self.sel_state.ordered_tuple()
        if not values:
            messagebox.showerror("Missing", "Select at least one Values field.")
            return
        if not index and not columns:
            messagebox.showerror("Missing", "Select at least one Index or Columns field.")
            return

        aggfunc = self.aggfunc_var.get().strip()
        if not aggfunc:
            aggfunc = "sum"

        # Validate fields exist
        all_fields = set(values + index + columns)
        missing = [f for f in all_fields if f not in self.df.columns]
        if missing:
            messagebox.showerror("Missing columns", "These selected fields are not in the dataframe:\n\n" + ", ".join(missing))
            return

        df_work = self.df.copy()

        # Apply rail grouping if mapping exists
        if self.rail_to_group and "rail" in df_work.columns:
            df_work["rail"] = df_work["rail"].astype(str).map(lambda x: self.rail_to_group.get(str(x), str(x)))

        try:
            self._set_status("Creating pivot table...")
            pivot = pd.pivot_table(
                df_work,
                values=values,
                index=index if index else None,
                columns=columns if columns else None,
                aggfunc=aggfunc,
            )

            out_path = os.path.join(out_dir, fname)
            pivot.to_csv(out_path)

            self._set_status(f"Exported pivot to: {out_path}")
            messagebox.showinfo("Success", f"Pivot exported:\n\n{out_path}")

        except Exception as e:
            self._set_status("Pivot creation failed.")
            messagebox.showerror("Failed", str(e))


if __name__ == "__main__":
    # Basic ttk styling
    try:
        from ctypes import windll  # type: ignore
        windll.shcore.SetProcessDpiAwareness(1)  # better scaling on Windows
    except Exception:
        pass

    app = PivotBuilderApp()
    app.mainloop()
