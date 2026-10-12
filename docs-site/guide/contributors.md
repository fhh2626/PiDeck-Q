---
title: 贡献者
---

# 贡献者

感谢所有为上游 [PiDeck](https://github.com/ayuayue/PiDeck) 和 PiDeck-Q 做出贡献的人！以下上游历史贡献保留致谢；飞书、宠物等历史功能不代表当前 PiDeck-Q 仍提供这些能力。


## 代码贡献

<div class="contributors-list">

<div class="contributor-card">
  <div class="contributor-avatar">EJ</div>
  <div class="contributor-info">
    <strong>1900EasonJin</strong>
    <span class="contributor-handle">@1900EasonJin</span>
    <p>飞书/Lark 远程控制集成、系统标题栏侧栏开关 (#104)、宠物状态卡死修复 (#107)</p>
    <a href="https://github.com/1900EasonJin" target="_blank" rel="noreferrer">GitHub</a>
  </div>
</div>

<div class="contributor-card">
  <div class="contributor-avatar">zx</div>
  <div class="contributor-info">
    <strong>zx3022448</strong>
    <span class="contributor-handle">@zx3022448</span>
    <p>模型列表拉取优化及错误状态展示</p>
    <a href="https://github.com/zx3022448" target="_blank" rel="noreferrer">GitHub</a>
  </div>
</div>

<div class="contributor-card">
  <div class="contributor-avatar">Fr</div>
  <div class="contributor-info">
    <strong>frostime</strong>
    <span class="contributor-handle">@frostime</span>
    <p>自定义字体/字号与缩放比例、模型选择器自动滚动、最大推理等级、RPC 扩展 UI 生命周期修复、Pi session_info_changed 事件同步侧边栏标题</p>
    <a href="https://github.com/frostime" target="_blank" rel="noreferrer">GitHub</a>
  </div>
</div>

<div class="contributor-card">
  <div class="contributor-avatar">mg</div>
  <div class="contributor-info">
    <strong>magic2066</strong>
    <span class="contributor-handle">@magic2066</span>
    <p>修复 Codex 子代理会话导入展示、修复 Linux 桌面宠物拖拽和 dev 启动</p>
    <a href="https://github.com/magic2066" target="_blank" rel="noreferrer">GitHub</a>
  </div>
</div>

<div class="contributor-card">
  <div class="contributor-avatar">pk</div>
  <div class="contributor-info">
    <strong>pangolinknight</strong>
    <span class="contributor-handle">@pangolinknight</span>
    <p>主进程流式消息节流合并与工具结果截断，修复大会话渲染进程白屏</p>
    <a href="https://github.com/pangolinknight" target="_blank" rel="noreferrer">GitHub</a>
  </div>
</div>

<div class="contributor-card">
  <div class="contributor-avatar">m9</div>
  <div class="contributor-info">
    <strong>me9rez</strong>
    <span class="contributor-handle">@me9rez</span>
    <p>依赖清理、SkillManager 软连接扫描、TypeScript 增量编译产物整理 (#97, #86, #69)</p>
    <a href="https://github.com/me9rez" target="_blank" rel="noreferrer">GitHub</a>
  </div>
</div>

<div class="contributor-card">
  <div class="contributor-avatar">bf</div>
  <div class="contributor-info">
    <strong>bfzha</strong>
    <span class="contributor-handle">@bfzha</span>
    <p>VS Code 风格 Git 面板与复杂工作流支持 (#68)</p>
    <a href="https://github.com/bfzha" target="_blank" rel="noreferrer">GitHub</a>
  </div>
</div>

<div class="contributor-card">
  <div class="contributor-avatar">Lp</div>
  <div class="contributor-info">
    <strong>Lopution</strong>
    <span class="contributor-handle">@Lopution</span>
    <p>跨桌面边界 WSL 路径处理 (#84)</p>
    <a href="https://github.com/Lopution" target="_blank" rel="noreferrer">GitHub</a>
  </div>
</div>

<div class="contributor-card">
  <div class="contributor-avatar">bs</div>
  <div class="contributor-info">
    <strong>buaassp</strong>
    <span class="contributor-handle">@buaassp</span>
    <p>隐藏内部 pi-subagent 会话 (#57)</p>
    <a href="https://github.com/buaassp" target="_blank" rel="noreferrer">GitHub</a>
  </div>
</div>

<div class="contributor-card">
  <div class="contributor-avatar">zz</div>
  <div class="contributor-info">
    <strong>zzq168281-coder</strong>
    <span class="contributor-handle">@zzq168281-coder</span>
    <p>本地文件链接可交互、todo 挂件字体跟随界面设置 (#103)</p>
    <a href="https://github.com/zzq168281-coder" target="_blank" rel="noreferrer">GitHub</a>
  </div>
</div>

<div class="contributor-card">
  <div class="contributor-avatar">ws</div>
  <div class="contributor-info">
    <strong>weishiair</strong>
    <span class="contributor-handle">@weishiair</span>
    <p>禁用/冲突让位时删除内置扩展用户目录文件，避免第三方扩展工具冲突导致 RPC 失败</p>
    <a href="https://github.com/weishiair" target="_blank" rel="noreferrer">GitHub</a>
  </div>
</div>

<div class="contributor-card">
  <div class="contributor-avatar">cl</div>
  <div class="contributor-info">
    <strong>clancyclaw</strong>
    <span class="contributor-handle">@clancyclaw</span>
    <p>修复 RichInput 换行被吞掉，保证多行草稿完整保留</p>
    <a href="https://github.com/clancyclaw" target="_blank" rel="noreferrer">GitHub</a>
  </div>
</div>

</div>

<style scoped>
.contributors-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin: 20px 0;
}
.contributor-card {
  display: flex;
  gap: 16px;
  align-items: flex-start;
  padding: 16px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-soft);
}
.contributor-avatar {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: var(--vp-c-brand-1);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 16px;
  flex-shrink: 0;
}
.contributor-info {
  flex: 1;
  min-width: 0;
}
.contributor-info strong {
  display: block;
  font-size: 16px;
  color: var(--vp-c-text-1);
}
.contributor-handle {
  color: var(--vp-c-text-3);
  font-size: 14px;
}
.contributor-info p {
  margin: 4px 0;
  color: var(--vp-c-text-2);
  font-size: 14px;
  line-height: 1.5;
}
.contributor-info a {
  font-size: 13px;
}
</style>

## 其他贡献

- 所有提交 Issue、反馈建议和帮助推广的用户
- pi 生态的开发者们
