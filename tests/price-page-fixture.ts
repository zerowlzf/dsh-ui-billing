/**
 * The published price tables, recorded from the live documentation pages.
 *
 * The parser reads a server-rendered table, so its fixture is the table itself
 * rather than a hand-written approximation of one: the row spans, the footnote
 * markers, and the unit suffixes are exactly what the pages serve.
 *
 * @module @deepseek-ai/dsh-client-ui-billing/tests/price-page-fixture
 */

/** Recorded from https://api-docs.deepseek.com/zh-cn/quick_start/pricing/ */
export const PRICING_ZH_HTML = `<table style="text-align:center"><tr><td colspan="3" style="text-align:center">模型</td><td>deepseek-flash<sup>(1)</sup></td><td>deepseek-v4-pro<sup>(2)</sup></td></tr>
<tr><td colspan="3">BASE URL (OpenAI 格式)</td><td colspan="2"><a href="https://api.deepseek.com" target="_blank" rel="noopener noreferrer">https://api.deepseek.com</a></td></tr>
<tr><td colspan="3">BASE URL (Anthropic 格式)</td><td colspan="2"><a href="https://api.deepseek.com/anthropic" target="_blank" rel="noopener noreferrer">https://api.deepseek.com/anthropic</a></td></tr>
<tr><td colspan="3" style="text-align:center">模型版本</td><td>DeepSeek-V4.1-Flash</td><td>DeepSeek-V4-Pro-0813</td></tr>
<tr><td colspan="3">思考模式</td><td colspan="2">支持非思考与思考模式（默认）<br>切换方式详见<a href="/zh-cn/guides/thinking_mode">思考模式</a></td></tr>
<tr><td colspan="3">上下文长度</td><td colspan="2">1M</td></tr>
<tr><td colspan="3">输出长度</td><td colspan="2">最大 384K</td></tr>
<tr><td rowspan="7">功能</td><td colspan="2"><a href="/zh-cn/guides/json_mode">Json Output</a></td><td>支持</td><td>支持</td></tr>
<tr><td colspan="2"><a href="/zh-cn/guides/tool_calls">Tool Calls</a></td><td>支持</td><td>支持</td></tr>
<tr><td colspan="2"><a href="/zh-cn/guides/responses_api">Responses API</a></td><td>支持</td><td>支持</td></tr>
<tr><td colspan="2"><a href="/zh-cn/guides/anthropic_api">Anthropic API</a></td><td>支持</td><td>支持</td></tr>
<tr><td colspan="2"><a href="/zh-cn/guides/chat_prefix_completion">对话前缀续写（Beta）</a></td><td>支持</td><td>支持</td></tr>
<tr><td colspan="2"><a href="/zh-cn/guides/fim_completion">FIM 补全（Beta）</a></td><td>仅非思考模式支持</td><td>仅非思考模式支持</td></tr>
<tr><td colspan="2"><a href="/zh-cn/guides/vision">图像理解</a></td><td>支持</td><td>不支持</td></tr>
<tr><td rowspan="6">价格<sup>(3)</sup></td><td rowspan="2">百万tokens输入<br>（缓存命中）</td><td>空闲时段</td><td>0.02元</td><td>0.15元</td></tr>
<tr><td>高峰时段</td><td>0.04元</td><td>0.30元</td></tr>
<tr><td rowspan="2">百万tokens输入<br>（缓存未命中）</td><td>空闲时段</td><td>1元</td><td>4.5元</td></tr>
<tr><td>高峰时段</td><td>2元</td><td>9.0元</td></tr>
<tr><td rowspan="2">百万tokens输出</td><td>空闲时段</td><td>4元</td><td>13.5元</td></tr>
<tr><td>高峰时段</td><td>8元</td><td>27.0元</td></tr>
<tr><td colspan="3">并发限制<sup>(4)</sup></td><td>2500</td><td>500</td></tr>
</table>`

/** Recorded from https://api-docs.deepseek.com/quick_start/pricing/ */
export const PRICING_EN_HTML = `<table style="text-align:center"><tr><td colspan="3" style="text-align:center">MODEL</td><td>deepseek-flash<sup>(1)</sup></td><td>deepseek-v4-pro<sup>(2)</sup></td></tr>
<tr><td colspan="3">BASE URL (OpenAI Format)</td><td colspan="2"><a href="https://api.deepseek.com" target="_blank" rel="noopener noreferrer">https://api.deepseek.com</a></td></tr>
<tr><td colspan="3">BASE URL (Anthropic Format)</td><td colspan="2"><a href="https://api.deepseek.com/anthropic" target="_blank" rel="noopener noreferrer">https://api.deepseek.com/anthropic</a></td></tr>
<tr><td colspan="3" style="text-align:center">MODEL VERSION</td><td>DeepSeek-V4.1-Flash</td><td>DeepSeek-V4-Pro-0813</td></tr>
<tr><td colspan="3">THINKING MODE</td><td colspan="2">Supports both non-thinking and thinking (default) modes<br>See <a href="/guides/thinking_mode">Thinking Mode</a> for how to switch</td></tr>
<tr><td colspan="3">CONTEXT LENGTH</td><td colspan="2">1M</td></tr>
<tr><td colspan="3">MAX OUTPUT</td><td colspan="2">MAXIMUM: 384K</td></tr>
<tr><td rowspan="7">FEATURES</td><td colspan="2"><a href="/guides/json_mode">Json Output</a></td><td>✓</td><td>✓</td></tr>
<tr><td colspan="2"><a href="/guides/tool_calls">Tool Calls</a></td><td>✓</td><td>✓</td></tr>
<tr><td colspan="2"><a href="/guides/responses_api">Responses API</a></td><td>✓</td><td>✓</td></tr>
<tr><td colspan="2"><a href="/guides/anthropic_api">Anthropic API</a></td><td>✓</td><td>✓</td></tr>
<tr><td colspan="2"><a href="/guides/chat_prefix_completion">Chat Prefix Completion（Beta）</a></td><td>✓</td><td>✓</td></tr>
<tr><td colspan="2"><a href="/guides/fim_completion">FIM Completion（Beta）</a></td><td>Non-thinking mode only</td><td>Non-thinking mode only</td></tr>
<tr><td colspan="2"><a href="/guides/vision">Vision</a></td><td>✓</td><td>Not supported</td></tr>
<tr><td rowspan="6">PRICING<sup>(3)</sup></td><td rowspan="2">1M INPUT TOKENS<br>(CACHE HIT)</td><td>OFF-PEAK</td><td>$0.003</td><td>$0.022</td></tr>
<tr><td>PEAK</td><td>$0.006</td><td>$0.044</td></tr>
<tr><td rowspan="2">1M INPUT TOKENS<br>(CACHE MISS)</td><td>OFF-PEAK</td><td>$0.15</td><td>$0.66</td></tr>
<tr><td>PEAK</td><td>$0.3</td><td>$1.32</td></tr>
<tr><td rowspan="2">1M OUTPUT TOKENS</td><td>OFF-PEAK</td><td>$0.6</td><td>$1.98</td></tr>
<tr><td>PEAK</td><td>$1.2</td><td>$3.96</td></tr>
<tr><td colspan="3">Concurrency Limit<sup>(4)</sup></td><td>2500</td><td>500</td></tr>
</table>`
