# FluxDown-plugin

FluxDown-plugin 是用于管理个人 FluxDown 插件的仓库。每个插件以独立目录保存实现源码，并可按 FluxDown 插件规范打包成 `.fxplug` 发布包。

## 仓库目标

- 集中维护自己编写的 FluxDown 插件
- 让每个插件拥有独立的源码、清单和使用说明
- 保持插件实现与发布包之间可追溯
- 后续可统一加入打包、校验、版本管理和插件索引

## 目录结构

```text
FluxDown-plugin/
├── README.md
└── bilibili-bangumi/
    ├── README.md
    ├── manifest.json
    ├── auth.js
    ├── resolve.js
    ├── src/
    └── scripts/
```

### 插件目录约定

每个插件使用一个独立目录，目录名建议使用清晰、稳定的短名称。插件目录至少应包含：

```text
<plugin-name>/
├── README.md
├── manifest.json
└── resolve.js
```

如果插件有多个入口文件或辅助模块，也放在自己的插件目录中，不要与其他插件共用相同文件。

## 当前插件

| 插件 | FluxDown identity | 版本 | 功能 |
| --- | --- | --- | --- |
| [bilibili-bangumi](./bilibili-bangumi/) | `fluxdown@bilibili-bangumi` | `0.1.19` | 发现 Bilibili 番剧和 UP 主投稿、解析视频音频直链，并提供订阅 |

## 插件包格式

FluxDown 插件发布包是一个 ZIP 格式的归档文件，通常使用 `.fxplug` 扩展名。压缩包根目录必须直接包含 `manifest.json`，例如：

```text
plugin.fxplug
├── manifest.json
└── resolve.js
```

安装器会读取并校验 `manifest.json`，然后将插件安装到 FluxDown 的插件目录中。开发目录安装则要求选择直接包含 `manifest.json` 的插件目录。

当前 Flutter 客户端的 ZIP 文件选择器只显示 `.zip` 扩展名。安装 `.fxplug` 时，可临时将扩展名改为 `.zip`；文件内容不需要修改，也不要重复压缩。

## 开发与维护流程

新增或更新插件时，建议按以下顺序操作：

1. 在仓库根目录创建插件目录。
2. 编写 `manifest.json`，确定 identity、版本、匹配规则和设置项。
3. 编写入口脚本及辅助文件。
4. 为插件补充自己的 README，记录功能、配置、安装和限制。
5. 使用 FluxDown 的开发目录安装功能进行本地验证。
6. 验证正常后，将插件目录打包为 `.fxplug`。
7. 更新插件版本、发布包和索引记录，确保版本号保持一致。

## manifest 要点

`manifest.json` 至少需要准确描述：

- `identity`：插件的稳定唯一标识；
- `name`、`version`、`description`：插件展示信息；
- `minAppVersion`：最低 FluxDown 版本；
- `resolvers`：链接匹配规则、入口文件和解析超时时间；
- `subscriptions`：订阅 provider ID、入口文件和订阅超时时间；
- `settings`：插件可配置的设置项。

插件入口应通过 FluxDown 插件运行时提供的能力完成网络请求、存储和结果返回，不应依赖宿主客户端内部文件路径或未声明的接口。

## 版本管理

- 插件版本使用语义化版本号，例如 `0.1.0`。
- 修改用户可见功能或兼容行为时，应更新插件版本。
- `manifest.json`、插件目录说明和发布包中的版本必须一致。
- 不同插件各自独立版本，不要求整个仓库使用单一版本号。

## 安全与隐私

- 不要把 Cookie、Token、密码或其他登录凭据提交到仓库。
- 插件应限制网络请求范围，并对外部响应进行基本校验。
- 用户数据只在实现确有必要时存储，并在插件 README 中说明用途。
- 发布前检查压缩包，确认没有临时文件、调试日志或本地配置。

## 发布前检查清单

- [ ] 插件目录中存在 `manifest.json` 和入口脚本。
- [ ] `manifest.json` 可以被 FluxDown 校验并且版本号正确。
- [ ] 链接匹配规则覆盖目标页面，但不会误匹配无关链接。
- [ ] 网络失败、接口错误和空结果都有明确错误信息。
- [ ] 文件名和路径经过安全清理。
- [ ] Cookie、Token 和本机路径未进入源码或发布包。
- [ ] 已通过开发目录安装和 `.fxplug` 安装验证。
- [ ] 插件 README 已同步更新。
