# WorkBuddy 内置供应商调研与首期设计

> 日期：2026-10-19；状态：内部摸底完成，外部协议待验证。
> 意图：在 CCR 配置页管理订阅代理来源，将 WorkBuddy 作为普通可路由供应商，自动发现/注册模型，无需用户安装额外插件。
> 约束：保留现有 HTTP provider/transformer 管线和普通供应商行为；不重启真实服务、不自动读取/外传用户真实凭据；独立分支 PR，未经授权不合并/发布。

## 1. 现状与接入点（Phase 1）

```text
Web UI Providers → POST /api/config → config.json → ConfigService.reload
  → ProviderService 初始化 providers/modelRoutes
客户端 /v1/messages、/v1/chat/completions → 统一请求
  → provider transformer.transformRequestIn → HTTP 上游
  → provider transformer.transformResponseOut → 客户端协议
```

- [代码事实] `packages/core/src/services/provider.ts:29-135` 从 config providers 生成供应商实例，现要求 name/api_base_url/api_key；模型注册使用字符串数组，`registerProvider` 建立 `provider,model` 路由。
- [代码事实] `packages/core/src/types/llm.ts` 定义 ConfigProvider/LLMProvider，`packages/core/src/types/transformer.ts` 定义请求转换、认证、响应转换契约；`packages/core/src/api/routes.ts:920-958` 支持转换器返回 body/config（可改 headers/url），现有 Anthropic transformer 可复用消息转换。
- [代码事实] `packages/core/src/ccr/admin-routes.ts:265-355` 已有保存、备份、运行时重建、健康状态清理和 probe 重载；新功能应复用而非另建无同步的配置写入路径。
- [代码事实] `packages/ui/src/components/Providers.tsx:300-445` 支持供应商 CRUD 与保存、刷新；`packages/ui/src/types.ts:6-29` 描述 UI Provider；`packages/ui/src/App.tsx` 已在配置界面渲染 Providers。因此优先在现有供应商区增加“内置/订阅来源”入口，而非重复建第二套配置列表。
- [代码事实] `packages/core/src/transformer/index.ts` 统一注册内置 transformer（含 AMD、Anthropic 等），无需第三方插件即可扩展供应商协议。

### 首期预计接触面

- Core：内置 WorkBuddy 认证/模型发现服务、管理 API、协议转换器及注册、provider 类型/初始化（按协议调研决定最小改动）。
- UI：Provider 类型、API 方法、WorkBuddy 供应商管理组件、现有配置页入口、中文/英文文案。
- Tests：隔离凭据/HTTP mock，模型发现与自动注册、JSON/SSE/tools/usage/errors/abort、安全边界，UI 交互与构建。
- 不改：普通 provider 默认行为、用户 Router 默认选择、项目 takeover/模型偏好；注册模型不等于自动替换用户路由。

### 已知约束/风险

1. Token 不得写入日志、错误正文或自动暴露给浏览器；凭据读取需用户显式触发，拒绝任意文件路径/任意凭据外传目标。
2. 首次连接/模型刷新必须原子更新或先验证再保存，失败保留旧模型，不用空列表覆盖；创建同名 provider 拒绝覆盖普通 provider。
3. 保存配置走既有流程保持运行时一致；避免新管理操作与全量配置保存造成丢字段。
4. 需要核实 WorkBuddy 当前数据面、登录/刷新凭据、模型列表协议；不能凭 Magpie README 宣称可用，也不照搬其完整账号池和反检测设计。
5. 规模不是 3 文件小改：Core/UI/测试可独立模块并行实现，整合后必须独立审查。

## 2. 外部调研

待填写：Magpie WorkBuddy 具体源码、上游支持边界、失败案例与许可证；所有结论记录 commit/路径及 URL。

## 3. 方案对比与推荐

待协议核实：A. CCR 内置数据面适配（优先）；B. CCR 调用 Magpie 独立服务（额外进程、非用户首选）；C. 官方公开 API（若与订阅同权可用，优先于内部协议）。

## 4. 详细设计与验收

待外部材料交叉验证后锁定契约。

## 5. 盲区

未授权真实账号登录/推理测试；不承诺第三方订阅接入免封号；调研不自动意味着 upstream 许可或 ToS 授权。
