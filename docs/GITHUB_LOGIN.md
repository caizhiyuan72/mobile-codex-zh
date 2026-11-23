# GitHub 浏览器授权

本次方案使用项目自己的 **GitHub OAuth App Device Flow**：在 Android 中显示设备码，用户到 GitHub 浏览器页面登录并确认，再由应用保存授权。它不依赖 `gh`、Linux 环境或 Client Secret，也不使用 GitHub CLI 官方的 Client ID。

当前新增入口需随新版源码编译、安装后使用。2026-11-17 已使用用户注册的 OAuth App 完成真实浏览器设备授权，通过 GitHub `/user` 核对账号 `caizhiyuan72`，并将开发分支 `feat/api-codex-ui` 推送到本仓库。该次授权用于本次构建进程，不表示旧 APK 已安装新登录入口或保存了应用内登录。

## 注册一次自己的 OAuth App

以下 GitHub 网页操作由用户自己完成：

1. 打开 [注册 OAuth App](https://github.com/settings/applications/new)，或进入 GitHub → Settings → Developer settings → OAuth Apps → New OAuth App。
2. Application name 可填写 `Codex CN`。Homepage URL 可使用项目地址 `https://github.com/caizhiyuan72/mobile-codex-zh`。
3. 如果注册页要求 Authorization callback URL，可填写同一项目地址作为仅供 Device Flow 注册使用的占位值。Device Flow 不通过该地址交换授权码，也不需要 Android 拦截网页回调；将来若增加普通网页 OAuth，必须另行实现真实回调。
4. 勾选 **Enable Device Flow**。应用在设备授权时请求 `offline_access`，加密保存 GitHub 返回的刷新令牌，并自动续期。对之前已过期且没有刷新令牌的连接，升级后需重新授权一次；GitHub 撤销授权或刷新凭据失效时也需重新授权。
5. 点击 Register application，复制页面上的 **Client ID**，填入应用的 GitHub 登录页。Client ID 是公开的应用标识；不要生成、粘贴或提交 Client Secret，也不要复制 `gh` 等其他应用的 Client ID。

以后普通登录无需重新注册 OAuth App。只需在应用中开始授权、打开 `https://github.com/login/device`、输入本次设备码，并核对 GitHub 显示的应用名称、账号和权限。网页批准后，应等应用确认实际 GitHub 账号，再认为登录完成。设备码过期后重新发起即可。

## 权限与推送范围

本方案请求 `public_repo`、`workflow` 和 `offline_access`。`offline_access` 用于获得刷新令牌，不授予额外的仓库权限，也不会出现在 GitHub 返回的权限列表中。

| Scope | 用途与范围 |
| --- | --- |
| `public_repo` | 读取、写入当前用户有权限操作的公共仓库；权限也涵盖公共仓库的部分状态、协作者和 Webhook 等操作。它不限于当前项目。 |
| `workflow` | 添加、更新 GitHub Actions 工作流文件，例如 `.github/workflows/build-android.yml`。仅普通代码推送不总是需要此项。 |

不请求覆盖私有仓库的 `repo` scope。OAuth App 不能像 GitHub App 或 fine-grained PAT 一样让 GitHub 将授权限定到单个仓库；应用在本地限制远端地址或仓库路径，也不会缩小令牌在 GitHub 服务端的权限。应用校验实际 scope，只接受 `public_repo` 与 `workflow`；缺少所需权限，或旧授权包含 `repo` 等额外权限，均不保存令牌。遇到后者应撤销旧授权或注册独立 OAuth App，再重新授权。

使用此 OAuth token 的普通 `git push` 可以触发仓库匹配的 `on: push` 工作流；它不是 Actions 自带的 `GITHUB_TOKEN`，不适用后者避免递归触发的推送限制。工作流仍须已启用，并符合分支、文件路径及仓库策略。当前构建只监听源码和构建工作流的改动；只更新文档时，可以在 Actions 页面手动执行已配置的 `workflow_dispatch`。

退出应用内登录应清除本地令牌并停止正在进行的授权。若要在 GitHub 服务端撤销权限，还需到 [Authorized OAuth Apps](https://github.com/settings/applications) 撤销对应应用；清除本地令牌与服务端撤销是两件操作。

## 实现与验收约定

设备流仅向 GitHub 官方 HTTPS 端点请求，应用不会主动将令牌发送到聊天上下文、源码、远端 URL、命令参数、日志或构建附件。每次授权成功后通过 `GET https://api.github.com/user` 校验实际账号，避免浏览器切换账号造成错误绑定。持久令牌存于 Android Keystore 保护的应用私有存储；更换 Client ID、退出或取消授权后，迟到的网络响应不得重新保存旧令牌。

Git 的子进程环境只包含本地凭据服务的随机访问凭证，OAuth token 由 helper 按需获取。能够在同一执行环境运行代码的代理也能调用该服务；这不是对代理执行代码的凭据隔离。

| 阶段或响应 | 处理方式 |
| --- | --- |
| 请求设备码 | `POST https://github.com/login/device/code`，发送 `client_id`、`scope=public_repo workflow offline_access`，使用 `Accept: application/json`。设备响应中的 `expires_in` 和 `interval` 为准，不能写死 15 分钟或 5 秒。 |
| 轮询令牌 | `POST https://github.com/login/oauth/access_token`，发送 `client_id`、`device_code`、`grant_type=urn:ietf:params:oauth:grant-type:device_code`，无需 `client_secret`。首次和后续轮询均遵守最小间隔。 |
| `authorization_pending` | 正常等待，按原间隔继续；不是登录失败。 |
| `slow_down` | 增加至少 5 秒，并遵守服务端返回的更大 `interval`；不立即重试。 |
| `expired_token` / `token_expired` | 停止轮询，清除设备码，让用户重新发起。GitHub 官方错误表与说明使用了这两种拼写。 |
| `access_denied`、取消或客户端配置错误 | 停止本次授权，显示明确原因；不自动重新开始。`device_flow_disabled` 应提示开启 OAuth App 的 Device Flow。 |
| 成功响应含 `expires_in` 和刷新字段 | 首次登录用 `/user` 确认账号；续期使用该账号同一授权的刷新令牌，无需 Client Secret。返回的新访问令牌与轮换的刷新令牌一并加密保存。正常在到期前续期；应用休眠期间到期时，恢复后的 Git 请求可短暂等待刷新。临时故障保留授权并稍后重试；刷新凭据失效或到期后要求重新授权。 |

Git 凭据接口需要区分两层：主命令是 `git credential fill`，不是 `git credential get`；配置的 credential helper 才由 Git 追加调用 `get`、`store`、`erase` 操作。

Git 通过 helper 的标准输入发送如下键值，每行一个字段，以空行结束：

```text
protocol=https
host=github.com
path=caizhiyuan72/mobile-codex-zh.git

```

helper 校验 `protocol=https`、`host=github.com` 后，通过标准输出返回 `username=x-access-token`、`password=<OAuth token>`，并以空行结束。这里的用户名是 Git HTTPS 的非空占位值，真正的账号由令牌及 `/user` 响应决定。不能向其他主机或 HTTP 返回令牌。当前凭据按 GitHub 主机提供，未增加本地单仓库限制；默认 Git 可能不传 HTTP 路径，若未来增加路径隔离，还需设置 `credential.useHttpPath=true` 并校验 `path`。当前 `store`、`erase` 为无输出的空操作，本地令牌由应用登录状态管理；失败不能将令牌回显到错误信息。运行 `git credential fill` 会把凭据输出到标准输出，因此不能把它直接作为会展示结果的调试命令。

令牌登录不自动授权提交、推送、发布或修改仓库设置；这些操作仍应遵循用户当次任务的授权。

## 首次安装

旧 APK 没有新登录入口，可以先使用源码中的一次性 [Python 授权脚本](../upstream-source/tools/github_device_login.py)。它由手机已有的 Python 直接运行，不需要外部 `gh`、Linux、PAT 或 Client Secret。先按上面的步骤注册 OAuth App，并取得自己的公开 Client ID。

在本仓库根目录运行，只验证浏览器授权、不推送：

```sh
python upstream-source/tools/github_device_login.py \
  --client-id '替换为自己的公开ClientID' \
  --repository caizhiyuan72/mobile-codex-zh \
  --expected-login caizhiyuan72
```

脚本显示一次性设备码后，用户自己打开 `https://github.com/login/device`，输入并确认。终端会等待授权、验证账号与权限，结束后不保存访问令牌。如果确认要将当前提交推送到开发分支并触发构建，使用：

```sh
python upstream-source/tools/github_device_login.py \
  --client-id '替换为自己的公开ClientID' \
  --repository caizhiyuan72/mobile-codex-zh \
  --expected-login caizhiyuan72 \
  --branch feat/api-codex-ui \
  --push
```

`--push` 是明确的推送开关。脚本仅推送当前 `HEAD`，不自动暂存或提交修改，不强制覆盖分支；先确认需要构建的源码已经提交。`--repository` 使用 `所有者/仓库`，不加 URL 或 `.git` 后缀；`--expected-login` 必须是自己预期的 GitHub 账号。浏览器登录错账号会中止。脚本的临时凭据 helper 进一步限定本次指定仓库；这仍不改变 OAuth token 在 GitHub 服务端的权限范围。

令牌只保留在进程内存中，推送结束、失败或按 `Ctrl+C` 取消后不写入持久凭据。若推送已发出，取消不表示服务器回滚，应查看仓库实际分支状态。仅验证授权的第一次运行不会为后续命令保留登录，下次推送需要再次授权。也可继续使用已有开发环境或 GitHub 网页上传源码。

推送成功后，在 [Actions](https://github.com/caizhiyuan72/mobile-codex-zh/actions) 核对对应提交的构建结果；成功推送不等于构建成功。新源码生成并安装对应 APK 后，才可使用应用内登录入口。整个流程不通过启用 Linux 或绕过 Android 执行限制运行外部 `gh`。

本轮真实授权、开发分支推送和 Actions 触发已完成。构建结果与产物关联见 [源码状态](SOURCE_STATUS.md)；尚未安装新版 APK，也未验证新版原生 Keystore 和 helper 的真机登录流程。

## 官方依据

核对日期：2026-11-17。

- [创建 OAuth App：Device Flow 开关、首页/回调与默认令牌到期](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)
- [OAuth Device Flow：端点、轮询、错误与无 Client Secret](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow)
- [OAuth 访问令牌到期与刷新](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#expiring-access-tokens)
- [OAuth App scopes 与实际授权范围](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)
- [Actions 的事件触发及 GITHUB_TOKEN 限制](https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow)
- [Git credential helpers 的调用契约](https://git-scm.com/docs/gitcredentials#_custom_helpers)
- [git credential 的 fill/approve/reject 与输入输出格式](https://git-scm.com/docs/git-credential)
