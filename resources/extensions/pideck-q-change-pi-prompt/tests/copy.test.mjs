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

test('shellProbeStatus formats all combinations in zh-CN and en-US', () => {
  const zh = shellUnavailableCopy('zh-CN');
  const en = shellUnavailableCopy('en-US');

  const availResult = { status: 'available', reason: 'static-candidate', source: 'environment', candidate: 'D:\\Git\\bin\\bash.exe' };
  const unknownResult = { status: 'unknown', reason: 'windows-app-alias', source: 'path', candidate: 'C:\\WindowsApps\\bash.exe' };
  const missingResult = { status: 'missing', reason: 'no-candidate' };

  // 1. zh-CN checks
  const zhRetained = zh.shellProbeStatus('bash', availResult, 'retained');
  assert.match(zhRetained, /发现静态候选/);
  assert.match(zhRetained, /保留已有活动工具/);
  assert.match(zhRetained, /source: environment/);
  assert.ok(zhRetained.includes('candidate: "D:\\\\Git\\\\bin\\\\bash.exe"'));

  const zhUnknownRetained = zh.shellProbeStatus('bash', unknownResult, 'retained');
  assert.match(zhUnknownRetained, /探测未确定/);
  assert.match(zhUnknownRetained, /保留已有活动工具/);

  const zhUnknownInactive = zh.shellProbeStatus('bash', unknownResult, 'inactive');
  assert.match(zhUnknownInactive, /探测未确定/);
  assert.match(zhUnknownInactive, /工具未激活，未添加/);
  assert.notEqual(zhUnknownRetained, zhUnknownInactive);

  const zhHidden = zh.shellProbeStatus('bash', missingResult, 'hidden');
  assert.match(zhHidden, /未发现候选/);
  assert.match(zhHidden, /本轮已移除工具/);
  assert.match(zhHidden, /未定位候选来源/);
  assert.match(zhHidden, /未定位候选/);
  assert.doesNotMatch(zhHidden, /undefined/);

  // 2. en-US checks
  const enRetained = en.shellProbeStatus('bash', availResult, 'retained');
  assert.match(enRetained, /static candidate found/);
  assert.match(enRetained, /existing active tool retained/);
  assert.doesNotMatch(enRetained, /[\u4e00-\u9fa5]/); // English contains no Chinese

  const enHidden = en.shellProbeStatus('bash', missingResult, 'hidden');
  assert.match(enHidden, /no candidate found/);
  assert.match(enHidden, /tool removed in this pass/);
  assert.match(enHidden, /no candidate source/);
  assert.match(enHidden, /no candidate located/);
  assert.doesNotMatch(enHidden, /undefined/);
  assert.doesNotMatch(enHidden, /[\u4e00-\u9fa5]/);

  // 3. Path with newlines, tabs, ANSI escape, DEL, and Unicode line separators
  const dirtyCandidate = '/tmp/\x1b[2J"weird\\path"\r\n\t\x7f\x85\u2028\u2029/bash';
  const dirtyCandidateResult = { status: 'available', reason: 'static-candidate', source: 'path', candidate: dirtyCandidate };

  for (const copy of [zh, en]) {
    const formatted = copy.shellProbeStatus('bash', dirtyCandidateResult, 'retained');
    // Must NOT contain raw control characters or line separators
    assert.doesNotMatch(formatted, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
    // Must preserve escaped representations
    assert.ok(formatted.includes('\\u001b'));
    assert.ok(formatted.includes('\\r'));
    assert.ok(formatted.includes('\\n'));
    assert.ok(formatted.includes('\\t'));
    assert.ok(formatted.includes('\\u007f'));
    assert.ok(formatted.includes('\\u0085'));
    assert.ok(formatted.includes('\\u2028'));
    assert.ok(formatted.includes('\\u2029'));
    // Single line assertion
    assert.equal(formatted.includes('\n'), false);
    assert.equal(formatted.includes('\r'), false);
  }

  // 4. Parameterized matrix of 2 locales x 3 statuses x 3 actions
  const matrixStatuses = [
    { status: 'available', reason: 'static-candidate', source: 'path', candidate: 'C:\\Git\\bin\\bash.exe' },
    { status: 'unknown', reason: 'windows-app-alias', source: 'path', candidate: 'C:\\WindowsApps\\bash.exe' },
    { status: 'missing', reason: 'no-candidate' },
  ];
  const matrixActions = ['retained', 'hidden', 'inactive'];

  for (const locale of ['zh-CN', 'en-US']) {
    const copy = shellUnavailableCopy(locale);
    for (const res of matrixStatuses) {
      for (const act of matrixActions) {
        const line = copy.shellProbeStatus('bash', res, act);
        assert.ok(line.startsWith('shell: bash ['));
        assert.ok(line.includes(`(reason: ${res.reason}`));
        assert.doesNotMatch(line, /undefined/);

        if (locale === 'en-US') {
          assert.doesNotMatch(line, /[\u4e00-\u9fa5]/, 'en-US line must contain no Chinese');
          if (res.status === 'available') assert.ok(line.includes('static candidate found'));
          if (res.status === 'unknown') {
            assert.ok(line.includes('detection inconclusive'));
            assert.equal(line.includes('execution verified'), false, 'unknown must not claim verified');
          }
          if (res.status === 'missing') assert.ok(line.includes('no candidate found'));

          if (act === 'retained') assert.ok(line.includes('existing active tool retained'));
          if (act === 'hidden') assert.ok(line.includes('tool removed in this pass'));
          if (act === 'inactive') assert.ok(line.includes('tool inactive; not enabled'));
        } else {
          if (res.status === 'available') assert.ok(line.includes('发现静态候选'));
          if (res.status === 'unknown') assert.ok(line.includes('探测未确定'));
          if (res.status === 'missing') assert.ok(line.includes('未发现候选'));

          if (act === 'retained') assert.ok(line.includes('保留已有活动工具'));
          if (act === 'hidden') assert.ok(line.includes('本轮已移除工具'));
          if (act === 'inactive') assert.ok(line.includes('工具未激活，未添加'));
        }
      }
    }
  }
});
