import subprocess
import os
import sys
import shutil
import platform

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CSS_PATH = os.path.join(SCRIPT_DIR, "codex_theme.css")
TEMP_DIR = os.path.join(SCRIPT_DIR, "temp_asar_extracted")
NEW_ASAR = os.path.join(SCRIPT_DIR, "temp_patched.asar")

SIGNATURE_START = "/* __ANTIGRAVITY_CODEX_THEME_START__ */"
SIGNATURE_END = "/* __ANTIGRAVITY_CODEX_THEME_END__ */"

def detect_asar_path():
    system = platform.system()
    if system == "Windows":
        return os.path.expandvars(r"%LOCALAPPDATA%\Programs\antigravity\resources\app.asar")
    elif system == "Darwin":
        return "/Applications/Antigravity.app/Contents/Resources/app.asar"
    elif system == "Linux":
        candidates = [
            "/opt/Antigravity/resources/app.asar",
            os.path.expanduser("~/.local/share/antigravity/resources/app.asar"),
            "/usr/lib/antigravity/resources/app.asar"
        ]
        for c in candidates:
            if os.path.exists(c):
                return c
        return candidates[0]
    return None

def install():
    asar_path = detect_asar_path()
    if not asar_path or not os.path.exists(asar_path):
        print(f"[错误] 未找到 Antigravity 核心文件: {asar_path}")
        print("请检查 Antigravity 是否已正确安装。")
        return False
    
    backup_path = asar_path + ".before_codex_patch.bak"
    
    if not os.path.exists(CSS_PATH):
        print(f"[错误] 未找到样式文件: {CSS_PATH}")
        return False

    print("[1/4] 正在备份官方 app.asar 核心文件...")
    if not os.path.exists(backup_path):
        shutil.copy2(asar_path, backup_path)
        print(f"      已创建安全备份: {backup_path}")
    else:
        print("      已有备份文件存在，跳过备份。")

    print("[2/4] 正在解包 app.asar...")
    if os.path.exists(TEMP_DIR):
        shutil.rmtree(TEMP_DIR, ignore_errors=True)

    npx_cmd = "npx.cmd" if platform.system() == "Windows" else "npx"
    extract_cmd = f'{npx_cmd} -y @electron/asar extract "{asar_path}" "{TEMP_DIR}"'
    res = subprocess.run(extract_cmd, shell=True, capture_output=True, text=True)
    if res.returncode != 0 or not os.path.exists(os.path.join(TEMP_DIR, "dist", "preload.js")):
        print(f"[错误] 解包失败: {res.stderr}")
        return False

    print("[3/4] 正在注入 Codex 视觉与字体主题...")
    preload_path = os.path.join(TEMP_DIR, "dist", "preload.js")
    with open(preload_path, "r", encoding="utf-8") as f:
        content = f.read()

    # 清除历史注入（如果有）
    if SIGNATURE_START in content:
        s = content.find(SIGNATURE_START)
        e = content.find(SIGNATURE_END) + len(SIGNATURE_END)
        content = content[:s] + content[e:]

    with open(CSS_PATH, "r", encoding="utf-8") as f:
        css = f.read()

    injection = f"""
{SIGNATURE_START}
(() => {{
    const themeCss = `{css.replace('`', '\\`').replace('$', '\\$')}`;
    function injectCodexTheme() {{
        if (document.getElementById('antigravity-codex-theme-patch')) return;
        const style = document.createElement('style');
        style.id = 'antigravity-codex-theme-patch';
        style.textContent = themeCss;
        (document.head || document.documentElement).appendChild(style);
    }}
    if (document.readyState === 'loading') {{
        document.addEventListener('DOMContentLoaded', injectCodexTheme);
    }} else {{
        injectCodexTheme();
    }}
    window.addEventListener('load', injectCodexTheme);
}})();
{SIGNATURE_END}
"""
    new_content = content + "\n" + injection
    with open(preload_path, "w", encoding="utf-8") as f:
        f.write(new_content)

    print("[4/4] 正在重新封包 app.asar...")
    pack_cmd = f'{npx_cmd} -y @electron/asar pack "{TEMP_DIR}" "{NEW_ASAR}"'
    res = subprocess.run(pack_cmd, shell=True, capture_output=True, text=True)
    if res.returncode == 0 and os.path.exists(NEW_ASAR) and os.path.getsize(NEW_ASAR) > 15 * 1024 * 1024:
        shutil.copy2(NEW_ASAR, asar_path)
        # 清理临时工作目录
        if os.path.exists(NEW_ASAR):
            os.remove(NEW_ASAR)
        shutil.rmtree(TEMP_DIR, ignore_errors=True)
        print("\n=======================================================")
        print("  [√] 成功！Codex 视觉与排版主题已完美部署到 Antigravity！")
        print("  请完全退出并重启 Antigravity 客户端即可享受全新视觉体验。")
        print("=======================================================\n")
        return True
    else:
        print("[错误] 封包失败或文件大小异常。")
        return False

def uninstall():
    asar_path = detect_asar_path()
    if not asar_path:
        print("[错误] 无法检测目标系统路径。")
        return False
        
    backup_path = asar_path + ".before_codex_patch.bak"
    if os.path.exists(backup_path):
        print("[1/1] 正在恢复官方备份核心...")
        shutil.copy2(backup_path, asar_path)
        print("\n=======================================================")
        print("  [√] 成功！官方原版核心已恢复，已清除 Codex 主题。")
        print("  重启 Antigravity 客户端即可生效。")
        print("=======================================================\n")
        return True
    else:
        print(f"[错误] 未找到备份文件: {backup_path}，无法自动还原。")
        return False

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--uninstall":
        uninstall()
    else:
        install()
