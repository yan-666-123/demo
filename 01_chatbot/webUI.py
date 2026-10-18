import os

for proxy_variable in ("NO_PROXY", "no_proxy"):
    bypass_hosts = {
        host.strip()
        for host in os.environ.get(proxy_variable, "").replace(";", ",").split(",")
        if host.strip()
    }
    bypass_hosts.update(("localhost", "127.0.0.1"))
    os.environ[proxy_variable] = ",".join(sorted(bypass_hosts))

os.environ.setdefault("GRADIO_ANALYTICS_ENABLED", "False")

import gradio as gr
import requests
import json
import logging
import re
from pathlib import Path


# Author:@南哥AGI研习社 (B站 or YouTube 搜索“南哥AGI研习社”)


# 设置日志模版
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)


# 后端服务接口地址
url = "http://localhost:8012/v1/chat/completions"
headers = {"Content-Type": "application/json"}


# 默认流式输出 True or False
stream_flag = False


def send_message(user_message, history):
    # 封装请求的参数
    data = {
        "messages": [{"role": "user", "content": user_message}],
        "stream": stream_flag,
        "userId": "123",
        "conversationId": "123"
    }

    # Gradio 的 tuples 格式每一项是 [用户消息, 助手回复]
    history = history or []
    current_history = history + [[user_message, "正在生成回复..."]]
    yield current_history

    # 对deepseek-r1模型进行格式化处理
    def format_response(full_text):
        # 精确替换 <think> 和 </think>
        formatted_text = full_text
        formatted_text = re.sub(r'<think>', '**思考过程**：\n', formatted_text)
        formatted_text = re.sub(r'</think>', '\n\n**最终回复**：\n', formatted_text)
        # logger.info(f"formatted_text: {formatted_text}")
        return formatted_text.strip()

    # 流式输出
    if stream_flag:
        assistant_response = ""
        try:
            with requests.post(url, headers=headers, data=json.dumps(data), stream=True) as response:
                for line in response.iter_lines():
                    if line:
                        json_str = line.decode('utf-8').strip("data: ")
                        if not json_str:
                            logger.info(f"收到空字符串，跳过...")
                            continue
                        # logger.info(f"接收数据json_str:{json_str}")
                        if json_str.startswith('{') and json_str.endswith('}'):
                            try:
                                response_data = json.loads(json_str)
                                if 'delta' in response_data['choices'][0]:
                                    content = response_data['choices'][0]['delta'].get('content', '')
                                    # 实时格式化响应
                                    formatted_content = format_response(content)
                                    logger.info(f"接收数据:{formatted_content}")
                                    assistant_response += formatted_content
                                    updated_history = history + [[user_message, assistant_response]]
                                    yield updated_history
                                if response_data.get('choices', [{}])[0].get('finish_reason') == "stop":
                                    logger.info(f"接收JSON数据结束")
                                    break
                            except json.JSONDecodeError as e:
                                logger.error(f"JSON解析错误: {e}")
                                yield history + [[user_message, "解析响应时出错，请稍后再试。"]]
                                break
                        else:
                            logger.info(f"无效JSON格式: {json_str}")
                    else:
                        logger.info(f"收到空行")
                else:
                    logger.info("流式响应结束但未明确结束")
                    yield history + [[user_message, "未收到完整响应。"]]
        except requests.RequestException as e:
            logger.error(f"请求失败: {e}")
            yield history + [[user_message, "请求失败，请稍后再试。"]]

    # 非流式输出
    else:
        try:
            response = requests.post(url, headers=headers, data=json.dumps(data), timeout=(5, 60))
            if not response.ok:
                try:
                    error_detail = response.json().get("detail", response.text)
                except ValueError:
                    error_detail = response.text
                logger.error("后端返回 HTTP %s: %s", response.status_code, error_detail)
                yield history + [[user_message, f"后端返回 HTTP {response.status_code}: {error_detail}"]]
                return

            response_json = response.json()
            assistant_content = response_json["choices"][0]["message"]["content"]
            formatted_content = format_response(assistant_content)
            logger.info("非流式输出，格式化后的内容是: %s", formatted_content)
            yield history + [[user_message, formatted_content]]
        except requests.RequestException as e:
            logger.error("请求后端失败: %s", e)
            yield history + [[user_message, f"无法连接后端 {url}: {e}"]]
        except (ValueError, KeyError, IndexError, TypeError) as e:
            logger.error("后端响应格式异常: %s", e)
            yield history + [[user_message, f"后端响应格式异常: {e}"]]


# 微信风格聊天界面
CHAT_CSS = """
body, .gradio-container { background: #ededed !important; }
.gradio-container { max-width: 980px !important; margin: 0 auto !important; }
#chat-shell { max-width: 820px; margin: 24px auto; background: #f5f5f5; border-radius: 18px; overflow: hidden; box-shadow: 0 12px 40px rgba(0,0,0,.10); }
#chat-header { height: 68px; padding: 0 24px; display: flex; align-items: center; gap: 13px; background: #f7f7f7; border-bottom: 1px solid #e6e6e6; }
#chat-header .cat-mark { width: 42px; height: 42px; border-radius: 14px; display: grid; place-items: center; background: #fff0d9; font-size: 25px; }
#chat-header .title { color: #222; font-size: 17px; font-weight: 650; }
#chat-header .subtitle { color: #888; font-size: 12px; margin-top: 3px; }
#conversation, #conversation .bubble-wrap { background: #ededed !important; border: 0 !important; }
#conversation .message-wrap, #conversation .message-row { border: 0 !important; background: transparent !important; box-shadow: none !important; }
#conversation .flex-wrap.user, #conversation .flex-wrap.bot { border: 0 !important; background: transparent !important; box-shadow: none !important; padding: 0 !important; }
#conversation .message { border: 0 !important; border-radius: 14px !important; padding: 11px 15px !important; box-shadow: 0 1px 2px rgba(0,0,0,.06) !important; color: #000 !important; }
#conversation .message * { color: #000 !important; }
#conversation .message.user { background: #95ec69 !important; }
#conversation .message.bot { background: #fff !important; }
#conversation .avatar-container { width: 38px !important; height: 38px !important; border: 0 !important; background: #fff !important; align-items: center !important; justify-content: center !important; overflow: hidden; }
#conversation .avatar-image { display: none !important; }
#conversation .user-row .avatar-container::before, #conversation .bot-row .avatar-container::before { font-size: 25px; line-height: 1; }
#conversation .user-row .avatar-container::before { content: "👤"; }
#conversation .bot-row .avatar-container::before { content: "🐱"; }
#composer { padding: 14px 18px 18px; background: #f7f7f7; border-top: 1px solid #e5e5e5; }
#message-box textarea { border: 0 !important; box-shadow: none !important; background: transparent !important; font-size: 15px !important; }
#send-button { min-width: 92px; height: 44px; border: 0 !important; border-radius: 9px !important; background: #07c160 !important; color: white !important; font-weight: 600 !important; }
#send-button:hover { background: #06ad56 !important; }
@media (max-width: 640px) { #chat-shell { margin: 0; border-radius: 0; } #conversation { height: 68vh !important; } }
"""

HERE = Path(__file__).resolve().parent

with gr.Blocks(
    theme=gr.themes.Soft(primary_hue="green", neutral_hue="gray"),
    css=CHAT_CSS,
) as demo:
    with gr.Column(elem_id="chat-shell", scale=1):
        gr.HTML("""
        <div id="chat-header">
          <div class="cat-mark">🐱</div>
          <div><div class="title">猫咪顾问</div><div class="subtitle">在线 · 有问题就问，哼</div></div>
        </div>
        """)
        chatbot = gr.Chatbot(
            label="",
            elem_id="conversation",
            height=560,
            bubble_full_width=False,
            avatar_images=(str(HERE / "user_avatar.svg"), str(HERE / "cat_avatar.svg")),
            show_label=False,
        )

        with gr.Row(elem_id="composer", equal_height=True):
            message = gr.Textbox(
                label="",
                placeholder="发送消息给猫咪顾问…",
                lines=2,
                max_lines=5,
                scale=8,
                elem_id="message-box",
                show_label=False,
            )
            send = gr.Button("发送", scale=1, elem_id="send-button")

    # 发送按钮点击后，处理模型的响应
    send.click(send_message, [message, chatbot], chatbot, api_name=False)
    message.submit(send_message, [message, chatbot], chatbot, api_name=False)
    send.click(lambda: "", None, message, api_name=False)
    message.submit(lambda: "", None, message, api_name=False)


if __name__ == "__main__":
    demo.launch(server_name="127.0.0.1", server_port=7860, show_api=False)


