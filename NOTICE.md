# 出处与第三方声明

本插件的宠物前端与网络层蓝本来自 Cortico 桌宠形象包/World：

- 包名：`cortico-world-desktop-pet`
- 作者：Pal-AI-Lab（https://github.com/Pal-AI-Lab/Cortico）
- 许可：MIT —— 见同目录 `LICENSE.cortico-world-desktop-pet`
- 第三方声明：见同目录 `THIRD_PARTY_NOTICES.cortico-world-desktop-pet.md`
- 上游清单快照：`upstream-package.json.txt`（便于日后比对版本）

## 复制了什么

| 本插件里的路径 | 上游路径 | 改动 |
|---|---|---|
| `web/**`（519 个文件） | `web/**` | 改动三处：`pet.html` 多一行 `<script src="/web/dsh-pet-host.js">`、标题；`pet-app.js` 的菜单头改成本插件的 `BRAND`；`i18n/*.js` 的 `pet.title` |
| `web/brand/dafayou.png` | — | 新加：菜单头像（用户提供的图，扣掉白底） |
| `lib/pet-server.js` | `src/server.ts` | 移植为 JS；去掉换装页/OBS/形象包导入/语音；加 loopback CORS；端口改成临时分配 |
| `lib/packs.js` | `src/packs.ts` | 瘦身重写：只读 `web/` 下内置形象包的 `figure.json` |
| `lib/ws.js` | （上游用 npm `ws`） | 手写 RFC 6455 服务端，零依赖 |

## 新写的

`index.js`、`client.js`、`lib/brain.js`、`lib/prefs.js`、`lib/sight.js`、`web/dsh-pet-host.js`、`dev/**`、`README.md`。

## 形象素材

鲸鱼娘（`web/whale/`）的形象署名见其 `figure.json` 的 `author` / `credits`：
角色原设 溪月（上善无型），DeepSeek 女仆二创 ZipZipPipe。请按上游同样的方式保留署名。

`web/brand/dafayou.png` 是菜单头用的圆头像（同一角色的裁切图，白底已抠）。

> ⚠️ 二次分发前请自己确认一下：这套形象是**同人二创**，角色原设与二创作者是否允许再发布，
> 上游仓库的 MIT 覆盖的是代码，不一定覆盖美术资源。不确定的话，发仓库时可以把 `web/whale/`
> 换成你自己有权的形象包（`web/<id>/figure.json` 那套结构），代码本身不依赖某一只鲸鱼。
