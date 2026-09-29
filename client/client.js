/*
 * dsh-plugin-dm8-inspect —— 客户端（浏览器）半边。
 *
 * DSH 客户端插件契约要求的闭包工厂产物：整个文件只有一条语句，向页面的模块加载器
 * 登记一个工厂，模块体在工厂被物化时才执行。它不是 ESM、也不是普通 CJS，就是经典
 * 脚本；`package.json` 里 `exports["./client"]` 指向本文件，host 会把它按
 * `/plugins/<包名>/client.js` 提供出去。
 *
 * 手写而非用 tsdown 打包：本插件保持零依赖、无构建步骤，引入前端工具链会成为安装门槛。
 * 代价是不能用 JSX，改用 `React.createElement`；卡片复杂到需要 TS/JSX 时再引入构建，
 * 产物路径不用改。
 *
 * 这张卡片是独立版表单的移植（`dm8-inspect/public/index.html`）。
 * 字段表与 `lib/session-form.js` 的 FORM_FIELDS 必须一致 ——
 * tools/session-form-check.mjs 会断言两边不漂移。
 *
 * 两件做不到的事：
 *   · 点按钮不能直接发起巡检。DSH 的客户端插件没有「调用工具」的接口，
 *     这里只能填参数 + 保存；发起要由模型调 dm8_inspect。
 *   · 值不落盘。存在 host 进程内存里，dsh 重启后需要重新填。
 *
 * 安全约束：
 *   · 口令只出现在 fetch 的请求体里，不进 console、不进 localStorage/sessionStorage、
 *     不写 cookie、不拼进 URL（URL 会落服务端访问日志）；
 *   · 状态查询里 host 不回传口令内容，只回「有没有」；
 *   · 口令输入框用 type=password + autoComplete="off"。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-dm8-inspect',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require('react');
    var h = React.createElement;

    /** 与 lib/session-form.js 的 SECRET_ROUTE 必须一致。 */
    var ENDPOINT = '/api/dm8-inspect.secret';
    /** 与 lib/tool.js 的 TOOL_NAME 必须一致。 */
    var TOOL_NAME = 'dm8_inspect';

    var name = 'dm8-inspect-client';
    var inject = ['slots'];

    var COLOR = {
      text: 'var(--dsw-color-text, #1f2328)',
      dim: 'var(--dsw-color-text-secondary, #57606a)',
      border: 'var(--dsw-color-border, #d0d7de)',
      bg: 'var(--dsw-color-surface-subtle, rgba(127,127,127,0.06))',
      accent: 'var(--dsw-color-accent, #0969da)',
      ok: 'var(--dsw-color-success, #1a7f37)',
      err: 'var(--dsw-color-danger, #cf222e)',
    };

    /** 统一的请求封装：口令只在 body 里，不放 URL。 */
    function api(method, sessionId, payload) {
      var init = { method: method, credentials: 'same-origin', cache: 'no-store' };
      if (method === 'POST') {
        init.headers = { 'content-type': 'application/json' };
        init.body = JSON.stringify(Object.assign({ session: sessionId }, payload || {}));
      }
      var url = ENDPOINT + (method === 'POST' ? '' : '?session=' + encodeURIComponent(sessionId || ''));
      return fetch(url, init).then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok || !body || body.ok !== true) {
            throw new Error((body && body.error) || 'HTTP ' + res.status);
          }
          return body;
        });
      });
    }

    var INPUT_STYLE = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '4px 7px',
      fontSize: '12.5px',
      fontFamily: 'inherit',
      color: COLOR.text,
      background: 'transparent',
      border: '1px solid ' + COLOR.border,
      borderRadius: '5px',
    };

    function Field(props) {
      return h(
        'label',
        { style: { display: 'grid', gap: '3px', minWidth: 0 } },
        h(
          'span',
          { style: { fontSize: '11.5px', color: COLOR.dim, display: 'flex', alignItems: 'center', gap: '5px' } },
          props.secret
            ? h('span', {
                style: {
                  display: 'inline-block',
                  width: '7px',
                  height: '7px',
                  borderRadius: '50%',
                  background: props.configured ? COLOR.ok : COLOR.border,
                },
              })
            : null,
          props.label,
          props.secret && props.configured ? h('span', { style: { color: COLOR.ok } }, '已设置') : null
        ),
        h('input', {
          type: props.secret ? 'password' : 'text',
          value: props.value,
          autoComplete: 'off',
          spellCheck: false,
          placeholder: props.placeholder || '',
          disabled: props.busy,
          onChange: function (e) {
            props.onChange(e.target.value);
          },
          style: INPUT_STYLE,
        }),
        props.hint ? h('span', { style: { fontSize: '11px', color: COLOR.dim } }, props.hint) : null
      );
    }

    function Btn(props) {
      return h(
        'button',
        {
          type: 'button',
          disabled: props.disabled,
          onClick: props.onClick,
          style: {
            padding: '4px 10px',
            fontSize: '12px',
            fontFamily: 'inherit',
            cursor: props.disabled ? 'default' : 'pointer',
            color: props.primary ? '#fff' : COLOR.text,
            background: props.primary ? COLOR.accent : 'transparent',
            border: '1px solid ' + (props.primary ? COLOR.accent : COLOR.border),
            borderRadius: '5px',
            opacity: props.disabled ? 0.55 : 1,
          },
        },
        props.label
      );
    }

    /** 非秘密字段：保存时整体提交（空串在那里表示「清除」）。 */
    var PLAIN_FIELDS = [
      'targets',
      'user',
      'sshUser',
      'topN',
      'tsWarnPct',
      'tsCritPct',
      'slowSqlMs',
      'queryTimeoutMs',
      'outDir',
    ];

    /**
     * dm8_inspect 的调用卡片。props 是 slot 的四份 share + owner props，
     * 其中 `sessionId` 来自标准 props —— 服务端按同一个 id 存取，两边必须一致。
     */
    function Dm8InspectRow(props) {
      var sessionId = props.sessionId || '';

      // 每个字段一份本地草稿。秘密字段永远从空开始（host 不回传内容）；
      // 非秘密字段用 host 回传的当前值作初值。
      var draft = React.useState({});
      var values = draft[0];
      var setValues = draft[1];

      var st = React.useState({});
      var configured = st[0];
      var setConfigured = st[1];

      var bs = React.useState(false);
      var busy = bs[0];
      var setBusy = bs[1];

      var es = React.useState(null);
      var error = es[0];
      var setError = es[1];

      var ms = React.useState(null);
      var message = ms[0];
      var setMessage = ms[1];

      // 默认展开：收起后看不见字段。
      var os = React.useState(true);
      var open = os[0];
      var setOpen = os[1];

      React.useEffect(
        function () {
          var alive = true;
          api('GET', sessionId)
            .then(function (body) {
              if (!alive) return;
              setValues(body.values || {});
              setConfigured(body.configured || {});
            })
            .catch(function (e) {
              if (alive) setError(String((e && e.message) || e));
            });
          return function () {
            alive = false;
          };
        },
        [sessionId]
      );

      function field(k) {
        return values[k] === undefined ? '' : values[k];
      }
      function setField(k) {
        return function (v) {
          setValues(function (prev) {
            var next = Object.assign({}, prev);
            next[k] = v;
            return next;
          });
        };
      }

      function run(promise, done) {
        setBusy(true);
        setError(null);
        setMessage(null);
        promise
          .then(function (body) {
            setConfigured(body.configured || {});
            // 保存成功后：非秘密字段同步成服务端值，秘密字段清空（host 不回传）
            var base = Object.assign({}, body.values || {});
            base.password = '';
            base.sshPassword = '';
            setValues(base);
            setMessage(done);
          })
          .catch(function (e) {
            setError(String((e && e.message) || e));
          })
          .then(function () {
            setBusy(false);
          });
      }

      /**
       * 只提交用户本次填过的秘密字段：留空 = 保持原值（host 是合并写入）。
       * 非秘密字段整体提交。
       */
      function save() {
        var payload = {};
        for (var i = 0; i < PLAIN_FIELDS.length; i++) {
          var k = PLAIN_FIELDS[i];
          if (values[k] !== undefined) payload[k] = String(values[k]);
        }
        if (field('password') !== '') payload.password = field('password');
        if (field('sshPassword') !== '') payload.sshPassword = field('sshPassword');
        if (Object.keys(payload).length === 0) {
          setError('没有任何可保存的内容');
          return;
        }
        run(api('POST', sessionId, payload), '已保存到本次 dsh 进程内存');
      }

      function clear() {
        run(api('DELETE', sessionId), '已清除');
      }

      var grid2 = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' };

      return h(
        'div',
        {
          style: {
            margin: '6px 0',
            padding: '10px 12px',
            border: '1px solid ' + COLOR.border,
            borderRadius: '8px',
            background: COLOR.bg,
            fontFamily: 'inherit',
            maxWidth: '640px',
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' } },
          h('span', { style: { fontSize: '12px', fontWeight: 600, color: COLOR.text } }, 'DM8 巡检设置'),
          h(
            'span',
            { style: { fontSize: '11px', color: COLOR.dim, flex: 1, minWidth: '180px' } },
            '只留在本次 dsh 进程内存里，重启后需要重新填'
          ),
          h(Btn, {
            label: open ? '收起' : '展开',
            onClick: function () {
              setOpen(!open);
            },
            disabled: false,
          })
        ),

        open
          ? h(
              'div',
              { style: { display: 'grid', gap: '8px', marginTop: '8px' } },
              h(Field, {
                label: '目标（每行一个 host:port）',
                value: field('targets'),
                onChange: setField('targets'),
                placeholder: '10.127.11.40:5236',
                busy: busy,
                hint: '一个 = 单实例；两个及以上 = 集群巡检（DMDSC / 数据守护主备）',
              }),
              h(
                'div',
                { style: grid2 },
                h(Field, {
                  label: '数据库账号',
                  value: field('user'),
                  onChange: setField('user'),
                  placeholder: 'SYSDBA',
                  busy: busy,
                }),
                h(Field, {
                  label: '数据库口令',
                  secret: true,
                  configured: !!configured.password,
                  value: field('password'),
                  onChange: setField('password'),
                  placeholder: configured.password ? '已设置（留空则不改）' : '输入后点保存',
                  busy: busy,
                }),
                h(Field, {
                  label: 'SSH 账号（数据库服务器 OS 采集，可选）',
                  value: field('sshUser'),
                  onChange: setField('sshUser'),
                  placeholder: 'root 或 dmdba',
                  busy: busy,
                  hint: '填了才会做 OS 级检查；不填这些项判为「不适用」',
                }),
                h(Field, {
                  label: 'SSH 口令（可选）',
                  secret: true,
                  configured: !!configured.sshPassword,
                  value: field('sshPassword'),
                  onChange: setField('sshPassword'),
                  placeholder: configured.sshPassword ? '已设置（留空则不改）' : '留空则不做 OS 检查',
                  busy: busy,
                }),
                h(Field, {
                  label: 'Top N（Top 类巡检项条数）',
                  value: field('topN'),
                  onChange: setField('topN'),
                  placeholder: '10（范围 5~50）',
                  busy: busy,
                }),
                h(Field, {
                  label: '慢 SQL 阈值 ms',
                  value: field('slowSqlMs'),
                  onChange: setField('slowSqlMs'),
                  placeholder: '1000',
                  busy: busy,
                }),
                h(Field, {
                  label: '表空间告警阈值 %',
                  value: field('tsWarnPct'),
                  onChange: setField('tsWarnPct'),
                  placeholder: '80',
                  busy: busy,
                }),
                h(Field, {
                  label: '表空间严重阈值 %',
                  value: field('tsCritPct'),
                  onChange: setField('tsCritPct'),
                  placeholder: '90',
                  busy: busy,
                }),
                h(Field, {
                  label: '单条 SQL 超时 ms',
                  value: field('queryTimeoutMs'),
                  onChange: setField('queryTimeoutMs'),
                  placeholder: '30000',
                  busy: busy,
                }),
                h(Field, {
                  label: '报告目录（可选）',
                  value: field('outDir'),
                  onChange: setField('outDir'),
                  placeholder: '默认 <会话目录>/dm8-inspect-reports',
                  busy: busy,
                })
              ),
              h(
                'div',
                { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
                h(Btn, { label: busy ? '处理中…' : '保存', onClick: save, disabled: busy, primary: true }),
                h(Btn, { label: '全部清除', onClick: clear, disabled: busy }),
                message !== null ? h('span', { style: { fontSize: '12px', color: COLOR.ok } }, message) : null,
                error !== null ? h('span', { style: { fontSize: '12px', color: COLOR.err } }, error) : null
              ),
              h(
                'div',
                { style: { fontSize: '11px', color: COLOR.dim, lineHeight: 1.5 } },
                '取值优先级：本次调用参数 > 这里填的 > 凭据库 / 插件配置。' +
                  '这里只能填参数 —— DSH 的客户端插件没有发起工具调用的能力；' +
                  '保存后说一句「巡检一下」（用上面填的目标）或「巡检一下 10.127.11.40:5236」即可。'
              )
            )
          : null
      );
    }

    /**
     * 注册调用视图。该 slot 由 client-ui-tool 声明，ctx.slots.inject 等它存在后回调，
     * 在它重新声明后重跑，销毁时自动摘除。
     */
    function apply(ctx) {
      ctx.slots.inject('tool.call.toolview', function () {
        return ctx.slots.register({ name: 'tool.call.toolview', key: TOOL_NAME }, Dm8InspectRow);
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = name;
    return module.exports;
  },
});
