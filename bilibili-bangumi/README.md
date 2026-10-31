# Bilibili视频下载插件

`fluxdown@bilibili-bangumi` 是面向 FluxDown 的 Bilibili 番剧与投稿解析插件。支持番剧分集、普通 BV/AV 视频及 UP 主投稿订阅；解析 DASH 视频和音频地址后交由 FluxDown 下载。

## 功能

- 支持 Bilibili 番剧播放页：`/bangumi/play/ss...` 和 `/bangumi/play/ep...`
- 支持 Bilibili 番剧媒体页：`/bangumi/media/md...`
- 支持带 `season_id` 参数的番剧播放页和媒体页
- 支持 BV/AV 普通视频链接，`?p=N` 选择分 P（默认第 1 P）
- 支持移动端 Bilibili 番剧与普通视频链接
- 支持 `b23.tv`、`bili2233.cn` 短链，展开后复用普通视频、番剧或订阅入口
- 自动发现正片分集，并按集生成下载任务
- 可选发现番外、预告、PV、采访等分区
- 支持 DASH 视频画质选择：最佳、2160p、1440p、1080p、720p、480p
- 支持仅下载音频（M4A）
- 每个可用画质会生成独立下载条目，名称保持视频原名并追加画质（例如 [1080p-高清]）
- 优先使用高质量音频轨道，并将视频与音频交给 FluxDown 合并下载流程
- 支持浏览器 Cookie 头和 Netscape `cookies.txt` 格式，并按 Bilibili API 域名过滤 Netscape Cookie
- 支持 FD 可移植 `auth` 视图：未登录时展示 Bilibili 登录二维码，已登录时展示成功状态，认证档案供后续解析复用
- 支持以 `bilibili-bangumi` provider 订阅番剧及 UP 主投稿；宿主负责轮询、去重和创建下载任务
- 每个订阅可用 `providerConfig` JSON 独立设置 `quality`、`includeExtras`、`highestQualityOnly` 和 `limit`
- 文件名按 FluxDown 清单路径总长限制截断，并对同目录重名条目编号
- 普通视频链接支持 BV 号及 `av` + 数字 ID；AV 链接会通过视频信息接口读取对应 BV 号和分 P。

## 系统要求

- FluxDown `0.6.4` 或更高版本（需支持可移植 `auth` 视图）
- 能够访问 `api.bilibili.com`
- 需要登录权限的内容必须提供有效的 Bilibili Cookie
- DASH 音视频合并需要在 FluxDown 组件设置中安装或配置 FFmpeg

## 安装

### 从 `.fxplug` 安装包安装

在 FluxDown 的“设置 → 扩展 → 插件”中选择 `.fxplug` 包安装；安装后在插件列表启用。

`.fxplug` 包根目录需包含 `manifest.json`、`resolve.js`、`auth.js` 和 `main.js`；开发目录安装时也必须直接包含这四个文件。`main.js` 已内嵌二维码编码器及其 MIT 许可，不需要额外安装运行时依赖。

## 配置

安装插件后，在插件卡片的设置中可以配置：

| 设置 | 说明 | 默认值 |
| --- | --- | --- |
| 导入 Bilibili Cookie | 浏览器 Cookie 请求头或 Netscape `cookies.txt` 内容；Netscape 导入仅接受 Bilibili 域及根路径 Cookie | 空 |
| 包含番外与花絮 | 普通番剧清单同时列出番外、预告、PV、采访等分区；订阅可单独覆盖 | 关闭 |
| 优先最高画质 | 番剧清单每集只列最高可用画质 | 关闭 |
| 默认画质 | 普通链接默认画质；番剧订阅的默认画质上限（订阅可单独覆盖） | 最佳画质 |

显式 Cookie 作为插件设置保存在本机配置中；扫码登录凭据由 FluxDown 认证档案管理。不要提交或分享 Cookie。失效后重新扫码或导入有效 Cookie。
## 登录

在插件卡片中点击“认证/登录”：

1. 先向 Bilibili 校验已保存的登录态；仍有效时直接显示登录成功页，不生成新二维码。未登录时自动展示二维码和扫码指引，不显示站点、登录信息或“开始登录”表单；
2. 使用 Bilibili App 扫描并确认；
3. 每 2 秒自动检查扫码结果，成功后保存认证 Cookie、停止轮询并切换到登录成功页，不自动关闭窗口；
4. 后续解析自动复用已保存登录态，认证未过期前不需要重复扫码。

状态查询会向 Bilibili `/x/web-interface/nav` 验证 API 认证档案；服务端撤销的登录态不再显示已登录。网络失败只报告暂时无法检查，不删除凭据。

关闭窗口会停止轮询并清理二维码会话，不删除已保存的登录凭据。二维码过期或请求失败时可点击“刷新二维码”；登录成功后只有主动点击“重新扫码登录”才生成新二维码，新账号确认前保留旧认证档案。该视图不展示注销或账号输入表单。

## 使用

1. 复制 Bilibili 番剧播放页、媒体页或 BV/AV 普通视频链接。
2. 将链接交给 FluxDown 创建下载任务。
3. 番剧链接返回分集清单；普通视频直接按所选画质解析（可用 `?p=N` 指定分 P）。
4. FluxDown 获取短期播放地址并开始下载。

每一集会以番剧名和集数命名；番外等分区会放入对应的子目录。

## 解析流程

插件分两阶段工作：

1. 番剧链接 → 调用 Bilibili 番剧接口，读取分集清单。
2. BV/AV 链接 → 查询视频信息与分 P，再解析指定分 P 的 DASH 视频/音频地址。
3. 番剧集或订阅视频标识 → 调用播放接口获取短期直链，再返回给 FluxDown。

插件不创建后台定时器或直接创建订阅任务；订阅轮询、去重、过滤和建任务由 FluxDown 核心负责。

## 番剧订阅

在 FluxDown 的 RSS/订阅向导中，将来源选择为 `Bilibili 番剧 · bilibili-bangumi`，地址填写番剧播放页、媒体页或单集页，例如：

```text
https://www.bilibili.com/bangumi/play/ss12345
```

订阅每轮读取分集列表，按 providerConfig 生成可用画质条目；标题显示实际画质。核心启动订阅任务时会把指定画质交回插件二段解析。`providerConfig` 是 JSON 对象，可按订阅单独覆盖：

```json
{
  "quality": "1080",
  "includeExtras": false,
  "highestQualityOnly": false,
  "limit": 30
}
```

`quality` 可为 `best`、`2160`、`1440`、`1080`、`720` 或 `480`，表示最高画质上限；`audio` 不适用于订阅。番剧 `limit` 范围为 1–50，UP 主订阅为 1–30；UP 主默认只列最高画质。条目只有在播放接口提供可用的画质时才会出现。播放地址是短期直链，长时间暂停后可能需要重新解析或重试。

筛选设置仍可按标题过滤画质，例如包含 `1080p|720p`、排除 `HDR`。如果希望同一集保留多个画质，不要开启“智能剧集去重”。
## 常见问题

### 安装窗口看不到 `.fxplug`

`.fxplug` 是 zip 格式的插件包，直接选择该文件安装；不要解压后重复压缩。

### 安装后解析失败

依次检查：

- FluxDown 版本是否至少为 `0.6.4`；
- 插件是否已启用；
- Bilibili 链接是否为支持的番剧页面、BV/AV 普通视频页面或对应短链；
- Bilibili Cookie 是否有效，是否有对应内容的访问权限；
- 客户端是否能够访问 `api.bilibili.com`。

### 只能看到部分画质

Bilibili 返回的画质取决于账号权限、视频本身和当前播放接口结果。插件只会展示接口实际返回的画质，默认画质不会提升账号本身没有的权限。

清单中选定的画质请求失败时直接报错，不改用默认画质接口。画质枚举失败的分集仍保留可重试条目，并记录失败数；画质条目超过宿主 1000 项上限时，每集收敛为最高可用画质并记录缩减前后数量。订阅的部分失败、元数据缺失和最近分集范围限制也会写入诊断日志，不写 Cookie 或原始请求错误。

DASH 使用 MP4 视频与兼容的音频轨（按 MIME 判断，缺少元数据时沿用既有行为）；HEVC/AV1 的 MP4 流仍受支持。明确返回非 MP4 视频或仅提供不兼容音轨时会报错，不把它们伪装为 MP4 或静默丢弃音频。当前没有可靠的语言多音轨选择契约，仍按可用兼容音轨的带宽选择，不提供语言偏好设置。

### 下载地址很快失效

播放地址是短期直链。插件将其标记为临时地址，建议在解析完成后尽快开始下载；如果任务长时间暂停后失败，可以重新解析或重试任务。

## 文件

- `manifest.json`：插件身份、匹配规则、设置项和入口声明。
- `resolve.js`：Bilibili 番剧分集发现、Cookie 处理、DASH/FLV 地址解析和画质选择逻辑。
- `auth.js`：二维码登录会话、轮询和认证档案保存。
- `main.js`：可移植二维码登录视图及本地 PNG 编码，无第三方二维码图片请求。

## 版本

当前版本：`1.1.0`

`1.1.0`：统一扫码与手动 Cookie 的认证档案语义；移除无效的会话复用开关；支持订阅级 providerConfig；修正 Cookie 域过滤、画质回退和清单路径长度限制；拒绝不完整的多段 durl。

修复补充：指定画质失败不再换默认接口；登录状态增加服务端校验；校验 DASH 媒体 MIME，拒绝不兼容容器；补充清单画质缩减和逐项失败诊断。

认证清理兼容修复：FD 的 `flux.storage` 只提供 `get/set`，旧 Cookie 缓存以 `set('auth.cookie', '')` 清空，登录保存和注销不再调用不存在的 `storage.remove`。认证档案仍通过 `flux.auth.remove` 删除；测试替身与宿主 API 保持一致。

登录视图：声明 `contributes.views[].location = "auth"`，GPUI 与 Web 共用二维码和登录成功页；打开时恢复有效登录态，扫码成功后停留在成功页，显式重新扫码才生成新二维码，关闭时清理会话，最低 FD 版本为 `0.6.4`。

## UP 主投稿订阅

在 RSS/订阅向导中选择 bilibili-bangumi，地址填写 UP 主空间，例如：

https://space.bilibili.com/123456

每轮最多读取最新 20 条投稿；可用订阅 `providerConfig.limit` 将读取数量设为 1–30。每个视频默认只列最高可用画质，按 bvid + cid 生成稳定条目；核心负责轮询和去重。直播回放、合集订阅和高级关键词过滤暂不支持。投稿列表使用 Bilibili WBI 签名接口；插件会缓存并自动刷新 WBI key，登录 Cookie 继续复用现有认证设置。

## 源码结构

运行时入口仍是根目录的 `resolve.js`，源码按职责拆分在 `src/`：

- `runtime.js`：插件运行时、Cookie、HTTP 和 Bilibili API 基础能力
- `bangumi.js`：番剧分集发现和番剧单集解析
- `dash.js`：DASH、音频轨、画质和下载结果处理
- `subscriptions.js`：番剧订阅和 UP 主投稿订阅
- `entry.js`：对 FluxDown 暴露的 `resolve` 和 `subscribe` 入口
- `auth-view.js`：二维码视图状态与会话生命周期
- `qr-image.js`：沙箱内 PNG 编码；QR 矩阵复用 FD 已有 node-qrcode 1.5.4 编码器（`vendor/qrcode.js`，许可见 `vendor/LICENSE-qrcode`）

修改源码后，在插件目录执行：

```text
node scripts/build.mjs
```

该命令会重新生成根目录的 `resolve.js` 和 `main.js`，安装插件时使用 `manifest.json` 声明的入口。

## 短链

可直接输入 `https://b23.tv/...` 或 `https://bili2233.cn/...`。普通视频短链进入视频解析；番剧短链返回分集清单。订阅向导也可使用指向番剧或 UP 主空间的短链。

宿主自动跟随重定向，但不向插件提供最终 URL，因此插件从落地页的 canonical / Open Graph 元数据读取目标，不执行页面脚本。视频落地页包含分 P 状态时会保留该选择。

验证码、被截断的页面、缺少规范链接的页面和不支持的活动页会明确报错；此时可在浏览器打开短链，再复制完整地址。短链展开阶段不携带任务 Cookie；后续视频和番剧解析继续使用原有登录态。

回归检查（在插件目录执行）：

```text
node scripts/build.mjs
node --test scripts/shortlinks.test.mjs
```
