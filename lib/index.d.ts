/**
 * dsh-opencode-go-usage —— host 侧类型声明。
 */
import type { Context } from '@deepseek-ai/cordis'

/** cordis 插件名。 */
export declare const name: 'opencode-go-usage'

/** 依赖的宿主服务：web 路由注册表。`credentials` 是可选来源，用 `ctx.get` 惰性取。 */
export declare const inject: readonly ['webServer']

/**
 * 安装宿主侧插件：注册同源用量路由 `GET /opencode-go-usage`。
 * @param ctx - cordis 插件上下文。
 */
export declare function apply(ctx: Context): void
