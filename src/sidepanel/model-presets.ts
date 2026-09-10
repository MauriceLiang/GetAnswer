export const MODEL_PRESETS = [
  {
    id: 'deepseek',
    label: 'DeepSeek（V4 Flash）',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash'
  },
  {
    id: 'qwen',
    label: '通义千问（qwen-plus）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus'
  },
  {
    id: 'kimi',
    label: 'Kimi（K3）',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k3'
  }
] as const;
