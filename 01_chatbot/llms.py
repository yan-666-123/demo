import logging

from langchain_openai import ChatOpenAI
from settings import DEEPSEEK_API_KEY


logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

DEEPSEEK_BASE_URL = "https://api.deepseek.com"
DEEPSEEK_MODEL = "deepseek-chat"
DEFAULT_TEMPERATURE = 0.7


class LLMInitializationError(Exception):
    """Raised when the DeepSeek model cannot be initialized."""


def initialize_llm() -> ChatOpenAI:
    """Initialize the DeepSeek model using the local config file."""
    try:
        llm = ChatOpenAI(
            base_url=DEEPSEEK_BASE_URL,
            api_key=DEEPSEEK_API_KEY,
            model=DEEPSEEK_MODEL,
            temperature=DEFAULT_TEMPERATURE,
            timeout=30,
            max_retries=2,          
        )
    except Exception as e:
        logger.error("初始化 DeepSeek 模型失败: %s", e)
        raise LLMInitializationError(f"初始化 DeepSeek 模型失败: {e}") from e

    logger.info("成功初始化 DeepSeek 模型 %s", DEEPSEEK_MODEL)
    return llm


def get_llm() -> ChatOpenAI:
    """Return the only configured model, DeepSeek."""
    return initialize_llm()


if __name__ == "__main__":
    try:
        get_llm()
    except LLMInitializationError as e:
        logger.error("程序终止: %s", e)
