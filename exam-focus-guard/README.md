# AlphaCoding 考试切屏拦截

独立的 Chrome / Edge Manifest V3 扩展，可与当前目录的 AI Learning Assistant 同时安装。无需构建、API Key 或后台服务，直接加载本目录。

## 安装

1. 打开 Chrome 的 `chrome://extensions`（Edge 使用 `edge://extensions`），开启「开发者模式」。
2. 点击「加载已解压的扩展程序」，选择 `GetAnswer/exam-focus-guard` 目录，不是项目根目录或 `dist`。
3. 在进入考试前完成安装。对已经打开的页面，需要重新加载才会注入脚本；先确认答案已保存、页面允许刷新。
4. 进入 `https://nuc.alphacoding.cn/exam/` 下的作答页面后自动生效。禁用或卸载扩展后，也需要重新加载页面才能移除已注入的监听器。

需要支持 MAIN content script 的浏览器；manifest 将 Chrome 最低版本设为 111。

## 已确认的实现与适用范围

2026-09-13 检查了 `page-example/考试页面.txt` 引用的公开脚本：

[app.a51f5a4e18792fa38780.js](https://nuc.alphacoding.cn/exam/static/js/app.a51f5a4e18792fa38780.js)

该脚本中与样例 `data-v-3e22fd56` 对应的组件，在 `mounted` 中通过 `window.addEventListener('blur', this.leavePage)` 注册统计。`leavePage` 向 `examinees/recordSwitch/set` 上报 `examineePaperId`，再以服务器返回的 `switchWindowsTimes` 更新计数。

扩展在 `document_start` 注册窗口捕获监听，仅当事件目标是 `window` 且当前路径为 `/exam/examSingleMode/<id>/…` 或 `/exam/examMode/<id>` 时停止传播。路径匹配忽略大小写，并在每次事件时检查当前路径，支持从登录页进入考试以及 SPA 切题。注入方式参见 [Chrome content scripts 文档](https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts)。

输入框和编辑器的 `blur` 正常传递；样例脚本中的填空题依赖它保存答案。扩展不修改答案、页面计数文本或网络请求。当前作答页中其他依赖窗口失焦的处理也会被拦截。

## 验证和限制

在项目根目录执行（使用项目已有的 `jsdom` 开发依赖）：

```sh
node --test exam-focus-guard/tests/guard.test.mjs
```

测试覆盖未启用时上报计数、启用后连续切屏不新增上报、保留已有次数、输入框和代码失焦保存、SPA 切题、非作答页恢复事件，以及其他常规事件。

这是针对上述脚本版本的窗口失焦统计实现。已有服务器记录不会被清零，也不能撤回已发出的上报。其他域名、`/exam2/`、客户端原生统计或平台后续增加的其他检测机制不在适配范围内。没有在真实考试会话中验证服务器结果。

上线使用前，在允许测试的练习或模拟环境中记录原有次数，切换标签页及其他应用后返回，检查次数，并验证填空答案保存和切题仍正常。若查看 Network 中的 `recordSwitch/set`，应在测试开始前打开 DevTools；未安装扩展时打开 DevTools 本身也可能让页面失焦。页面数字不变不能单独证明服务器未记录。
