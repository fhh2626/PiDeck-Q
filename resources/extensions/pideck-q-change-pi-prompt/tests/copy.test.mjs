import assert from 'node:assert/strict';
import test from 'node:test';
import {
  UI_LANGUAGE_ENV_NAME,
  resolveExtensionLocale,
  shellUnavailableCopy,
} from '../copy.ts';

test('injected PIDECK_UI_LANGUAGE decides the locale', () => {
  assert.equal(resolveExtensionLocale({ [UI_LANGUAGE_ENV_NAME]: 'en-US' }), 'en-US');
  assert.equal(resolveExtensionLocale({ [UI_LANGUAGE_ENV_NAME]: 'zh-CN' }), 'zh-CN');
  // 宿主可能注入带区域的 BCP-47 标签，英文判定必须按前缀而不是全等。
  assert.equal(resolveExtensionLocale({ [UI_LANGUAGE_ENV_NAME]: 'en-GB' }), 'en-US');
});

test('missing injection falls back to the system locale, then to Chinese', () => {
  assert.equal(resolveExtensionLocale({}, 'en-US'), 'en-US');
  assert.equal(resolveExtensionLocale({}, 'zh-Hans-CN'), 'zh-CN');
  // 未知语言回退中文：项目历史文案以中文为主，回退英文会与既有提示不一致。
  assert.equal(resolveExtensionLocale({}, 'de-DE'), 'zh-CN');
  assert.equal(resolveExtensionLocale({}, undefined), 'zh-CN');
  // 空白注入值不能压过系统语言。
  assert.equal(resolveExtensionLocale({ [UI_LANGUAGE_ENV_NAME]: '   ' }, 'en-US'), 'en-US');
});

test('shell copy is available in both languages and never names bash as required', () => {
  const zh = shellUnavailableCopy('zh-CN');
  const en = shellUnavailableCopy('en-US');

  assert.equal(zh.allShellsHidden, 'PowerShell 及其他 Shell 工具均不可用，已对本会话隐藏对应工具。');
  assert.match(en.allShellsHidden, /PowerShell and other shell tools are unavailable/);
  // 「bash 不是必需品」：全不可用提示不得把 bash 当作唯一/必要的 shell 后端。
  assert.doesNotMatch(zh.allShellsHidden, /bash/i);
  assert.doesNotMatch(en.allShellsHidden, /bash/i);

  assert.match(en.searchHidden('grep'), /grep is unavailable/);
  assert.match(zh.searchHidden('grep'), /grep 的 rg\/fd 后端不可用/);
});
