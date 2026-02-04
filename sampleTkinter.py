'''
{
  "base_dir": "downloads/user/reports",
  "start_key": "v23",
  "file_name": "summaryReport",
  "output_dir": "summary",
  "groupings": { "g1": "", "g2": "", "g3": "" },
  "pivot": {
    "values": "D",
    "index": ["A", "B"],
    "columns": ["C"],
    "aggfunc": "sum",
    "fill_value": 0,
    "margins": false,
    "dropna": true
  }
}
'''
import json, os, traceback
import tkinter as tk
from tkinter import filedialog, messagebox
import pandas as pd

CONFIG_FILE = "config.json"


def get_groups():
    return ["g1", "g2", "g3"]


def default_config():
    return {
        "base_dir": os.path.abspath("."),
        "start_key": "v23",
        "file_name": "summaryReport",
        "output_dir": "summary",
        "groupings": {g: "" for g in get_groups()},
        "pivot": {
            "values": "D",
            "index": ["A", "B"],
            "columns": ["C"],
            "aggfunc": "sum",
            "fill_value": 0,
            "margins": False,
            "dropna": True,
        },
    }


def pretty(x): return json.dumps(x, indent=2, ensure_ascii=False)


def load_config():
    if not os.path.exists(CONFIG_FILE):
        cfg = default_config()
        save_config(cfg)
        return cfg
    with open(CONFIG_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def save_config(cfg):
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        f.write(pretty(cfg))


def parse_editor(t):
    s = t.get("1.0", "end").strip()
    return json.loads(s) if s else {}


def set_editor(t, cfg):
    t.delete("1.0", "end")
    t.insert("1.0", pretty(cfg))


def log_line(logw, msg):
    logw.config(state="normal")
    logw.insert("end", msg + "\n")
    logw.see("end")
    logw.config(state="disabled")


def ensure_groupings(cfg):
    cfg["groupings"] = {g: cfg.get("groupings", {}).get(g, "") for g in get_groups()}
    return cfg


def find_report_folders(base_dir, start_key):
    if not os.path.isdir(base_dir):
        raise FileNotFoundError(f"base_dir not found: {base_dir}")
    return [
        os.path.join(base_dir, d)
        for d in os.listdir(base_dir)
        if os.path.isdir(os.path.join(base_dir, d)) and d.startswith(start_key)
    ]


def collect_csv_files(folders):
    csvs = []
    for root in folders:
        for dp, _, files in os.walk(root):
            for fn in files:
                if fn.lower().endswith(".csv"):
                    csvs.append(os.path.join(dp, fn))
    return csvs


def build_df_from_reports(base_dir, start_key):
    folders = find_report_folders(base_dir, start_key)
    if not folders:
        raise FileNotFoundError(f"No folders starting with '{start_key}' under {base_dir}")

    csvs = collect_csv_files(folders)
    if not csvs:
        raise FileNotFoundError("No CSV files found inside matched folders.")

    frames = []
    for path in csvs:
        df = pd.read_csv(path)
        df["_source_file"] = os.path.basename(path)
        df["_source_dir"] = os.path.basename(os.path.dirname(path))
        frames.append(df)

    return pd.concat(frames, ignore_index=True), folders, csvs


def resolve_output_path(base_dir, output_dir, file_name):
    out_dir = output_dir if os.path.isabs(output_dir) else os.path.join(base_dir, output_dir)
    os.makedirs(out_dir, exist_ok=True)
    return os.path.join(out_dir, f"{file_name}.csv")


def run_pivot(cfg):
    base_dir = cfg["base_dir"]
    start_key = cfg["start_key"]
    file_name = cfg["file_name"]
    output_dir = cfg["output_dir"]
    pivot = cfg.get("pivot", {})

    df, folders, csvs = build_df_from_reports(base_dir, start_key)

    table = pd.pivot_table(
        df,
        values=pivot.get("values"),
        index=pivot.get("index"),
        columns=pivot.get("columns"),
        aggfunc=pivot.get("aggfunc", "sum"),
        fill_value=pivot.get("fill_value", None),
        margins=bool(pivot.get("margins", False)),
        dropna=bool(pivot.get("dropna", True)),
    )

    out_path = resolve_output_path(base_dir, output_dir, file_name)

    # write pivot to csv cleanly
    table.reset_index().to_csv(out_path, index=False)

    return out_path, len(folders), len(csvs), df.shape


def on_load(editor, logw):
    cfg = load_config()
    set_editor(editor, cfg)
    log_line(logw, "Loaded config.json")


def on_save(editor, logw):
    try:
        cfg = parse_editor(editor)
        save_config(cfg)
        log_line(logw, "Saved config.json")
    except Exception as e:
        messagebox.showerror("Save error", str(e))


def on_groupings(editor, logw):
    try:
        cfg = parse_editor(editor)
    except Exception:
        cfg = default_config()
    cfg = ensure_groupings(cfg)
    set_editor(editor, cfg)
    log_line(logw, f"Updated groupings keys: {get_groups()}")


def on_pick_base_dir(editor, logw):
    try:
        cfg = parse_editor(editor)
    except Exception:
        cfg = default_config()
    chosen = filedialog.askdirectory(initialdir=cfg.get("base_dir", os.path.abspath(".")))
    if not chosen:
        return
    cfg["base_dir"] = chosen
    set_editor(editor, cfg)
    log_line(logw, f"base_dir set to: {chosen}")


def on_run(editor, logw):
    try:
        cfg = parse_editor(editor)
        save_config(cfg)
        log_line(logw, "Collecting reports + running pivot...")
        out_path, n_folders, n_csvs, shape = run_pivot(cfg)
        log_line(logw, f"Matched folders: {n_folders}, CSVs read: {n_csvs}, df shape: {shape}")
        log_line(logw, f"Wrote: {out_path}")
        messagebox.showinfo("Done", f"Pivot generated:\n{out_path}")
    except Exception as e:
        log_line(logw, "Run failed:")
        log_line(logw, str(e))
        log_line(logw, traceback.format_exc())
        messagebox.showerror("Run error", str(e))


def make_ui():
    root = tk.Tk()
    root.title("Config Editor + Pivot Runner")
    root.geometry("980x700")

    top = tk.Frame(root)
    top.pack(fill="x", padx=10, pady=8)

    editor = tk.Text(root, wrap="none", undo=True)
    editor.pack(fill="both", expand=True, padx=10)

    logw = tk.Text(root, height=10, wrap="word", state="disabled")
    logw.pack(fill="x", padx=10, pady=(8, 10))

    tk.Button(top, text="Load", command=lambda: on_load(editor, logw)).pack(side="left", padx=4)
    tk.Button(top, text="Save", command=lambda: on_save(editor, logw)).pack(side="left", padx=4)
    tk.Button(top, text="Groupings", command=lambda: on_groupings(editor, logw)).pack(side="left", padx=4)
    tk.Button(top, text="Pick base_dir", command=lambda: on_pick_base_dir(editor, logw)).pack(side="left", padx=4)
    tk.Button(top, text="Run", command=lambda: on_run(editor, logw)).pack(side="left", padx=4)

    on_load(editor, logw)
    return root


if __name__ == "__main__":
    make_ui().mainloop()
