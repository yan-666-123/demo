import configparser
from pathlib import Path


_config = configparser.ConfigParser()
_config_path = Path(__file__).with_name("config.ini")
if not _config.read(_config_path, encoding="utf-8"):
    raise FileNotFoundError(f"配置文件不存在或无法读取: {_config_path}")

DEEPSEEK_API_KEY = _config.get("api", "deepseek_api_key", fallback="").strip()
LANGSMITH_API_KEY = _config.get("api", "langsmith_api_key", fallback="").strip()

if not DEEPSEEK_API_KEY:
    raise ValueError(f"配置文件中缺少 api.deepseek_api_key: {_config_path}")
