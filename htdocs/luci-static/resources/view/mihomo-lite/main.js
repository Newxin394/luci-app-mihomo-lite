'use strict';
'require view';
'require fs';
'require poll';
'require ui';

/*
 * Mihomo 极简代理 (luci-app-mihomo-lite)
 * 裸核 (bare-core) 管理界面：后端 /usr/share/mihomo/ctl.sh + /etc/init.d/mihomo
 * 持久覆写层：/etc/mihomo/mixin.yaml （head = 基础参数/DNS/策略组/规则；listeners = 服务端入站）
 */

var CTL = '/usr/share/mihomo/ctl.sh';
var INITD = '/etc/init.d/mihomo';
var MIXIN = '/etc/mihomo/mixin.yaml';

var MK_A = '# --- mihomo-lite managed start ---';
var MK_B = '# --- mihomo-lite managed end ---';

var S = {
	status: {},
	ports: [],
	head: '',
	listeners: '',
	tab: 'overview',
	logWhich: 'core',
	logLines: '200',
	sig: '',        /* 状态签名：没变就不重绘 DOM */
	logLen: -1      /* 日志长度：没变就不重绘 */
};

/* ---------------- 基础工具 ---------------- */

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function sh(cmd, args) {
	args = args || [];
	return fs.exec(cmd, args).then(function (r) {
		if (!r) throw new Error('no result');
		return r;
	}).catch(function () {
		return fs.exec_direct(cmd, args, 'text', true, true).then(function (out) {
			return { code: 0, stdout: out, stderr: '' };
		});
	});
}

function ctl(args) { return sh(CTL, args); }

function ctlJson(args) {
	return ctl(args).then(function (r) {
		var lines = String(r.stdout || '').trim().split('\n');
		var last = lines[lines.length - 1] || '';
		try { return JSON.parse(last); }
		catch (e) { return { ok: false, msg: last || _('命令执行失败') }; }
	});
}

function ctlLongJson(args) {
	return fs.exec_direct(CTL, args || [], 'text', true, true).then(function (out) {
		var lines = String(out || '').trim().split('\n');
		var last = lines[lines.length - 1] || '';
		try { return JSON.parse(last); }
		catch (e) { return { ok: false, msg: last || _('命令执行失败') }; }
	});
}

function notify(msg, kind) {
	ui.addNotification(null, E('p', {}, msg), kind || 'info');
}

function fmtSize(kb) {
	kb = parseInt(kb || 0);
	if (kb <= 0) return '—';
	if (kb < 1024) return kb + ' KB';
	return (kb / 1024).toFixed(1) + ' MB';
}

function fmtUptime(sec) {
	sec = parseInt(sec || 0);
	if (sec <= 0) return '—';
	var d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
	if (d > 0) return '%d 天 %d 时'.format(d, h);
	if (h > 0) return '%d 时 %d 分'.format(h, m);
	return '%d 分 %d 秒'.format(m, sec % 60);
}

/* ---------------- mixin.yaml 分块 ---------------- */

function splitMixin(txt) {
	var m = /^listeners:/m.exec(txt || '');
	if (!m) return { head: txt || '', listeners: '' };
	var i = m.index;
	return { head: txt.slice(0, i), listeners: txt.slice(i) };
}

function getKey(text, key, def) {
	var re = new RegExp('^' + escapeRe(key) + ':[ \\t]*(.*)$', 'm');
	var m = re.exec(text || '');
	if (!m) return def;
	var v = m[1].trim().replace(/^['"]|['"]$/g, '');
	return v === '' ? def : v;
}

function managedBlock(head) {
	var re = new RegExp('^' + escapeRe(MK_A) + '\\n([\\s\\S]*?)^' + escapeRe(MK_B), 'm');
	var m = re.exec(head || '');
	return m ? m[1] : '';
}

function replaceManaged(head, bodyLines) {
	var block = MK_A + '\n' + bodyLines.join('\n') + '\n' + MK_B;
	var re = new RegExp('^' + escapeRe(MK_A) + '[^\\n]*\\n[\\s\\S]*?^' + escapeRe(MK_B) + '[ \\t]*$', 'm');
	if (re.test(head)) return head.replace(re, block);
	var sep = /^---[ \t]*$/m;
	if (sep.test(head)) return head.replace(sep, '---\n' + block);
	return block + '\n' + head;
}

function parseListeners(txt) {
	var out = [], cur = null, m;
	String(txt || '').split('\n').forEach(function (l) {
		if ((m = /^\s*-\s*name:\s*(.+?)\s*$/.exec(l))) {
			if (cur) out.push(cur);
			cur = { name: m[1], type: '', port: '' };
		} else if (cur && (m = /^\s+type:\s*(.+?)\s*$/.exec(l))) {
			cur.type = m[1];
		} else if (cur && (m = /^\s+port:\s*(\d+)\s*$/.exec(l))) {
			cur.port = m[1];
		}
	});
	if (cur) out.push(cur);
	return out;
}

/* ---------------- DOM 组件 ---------------- */

function card(title, children, descr) {
	return E('div', { class: 'cbi-section' }, [
		E('h3', {}, [ title, descr ? E('span', { class: 'cbi-section-descr' }, ' ' + descr) : '' ]),
		E('div', {}, children)
	]);
}

function row(title, field, descr) {
	return E('div', { class: 'cbi-value' }, [
		E('label', { class: 'cbi-value-title' }, title),
		E('div', { class: 'cbi-value-field' }, [ field, descr ? E('div', { class: 'cbi-value-description' }, descr) : '' ])
	]);
}

function btn(label, style, onclick) {
	return E('button', {
		class: 'cbi-button cbi-button-' + (style || 'button'),
		click: function (ev) { ev.preventDefault(); return onclick(ev); }
	}, label);
}

function pre(boxId, height) {
	return E('pre', {
		id: boxId,
		style: 'max-height:%spx;overflow:auto;white-space:pre-wrap;word-break:break-all;font-size:12px;line-height:1.45;padding:8px;margin:0'.format(height || 260)
	}, '');
}

function setText(id, txt) {
	var el = document.getElementById(id);
	if (el) el.textContent = txt == null ? '' : String(txt);
}

function setHTML(id, html) {
	var el = document.getElementById(id);
	if (el) el.innerHTML = html;
}

/* ---------------- 视图 ---------------- */

return view.extend({
	load: function () {
		/* 一次 overview 拿状态 + 端口（原来是两次 exec），另加一次读 mixin.yaml */
		return Promise.all([
			L.resolveDefault(ctlJson(['overview']), {}),
			L.resolveDefault(fs.read(MIXIN), '')
		]);
	},

	render: function (data) {
		var ov = data[0] || {};
		S.status = ov.status || {};
		S.ports = ov.ports || [];
		var raw = data[1] || '';
		var sp = splitMixin(raw);
		S.head = sp.head;
		S.listeners = sp.listeners;

		var view = this;
		var panels = {};

		function tabBtn(id, title) {
			return E('button', {
				class: 'cbi-button',
				style: 'margin-right:6px',
				click: function (ev) {
					ev.preventDefault();
					view.switchTab(id);
				}
			}, title);
		}

		var tabbar = E('div', { style: 'margin-bottom:14px' }, [
			tabBtn('overview', _('运行状态')),
			tabBtn('sub', _('订阅与覆写')),
			tabBtn('server', _('服务端 (8080/8081)')),
			tabBtn('core', _('内核与面板更新')),
			tabBtn('logs', _('运行日志'))
		]);

		/* ---- Tab 1 运行状态 ---- */
		panels.overview = E('div', { id: 'tab-overview' }, [
			card(_('服务状态'), [
				E('div', { id: 'status-line', style: 'margin-bottom:10px;font-size:14px' }, _('读取中…')),
				E('div', { class: 'cbi-value' }, [
					E('div', { class: 'cbi-value-field' }, [
						btn(_('启动服务'), 'apply', function () { return view.serviceAction('start'); }),
						' ',
						btn(_('重启服务'), 'action', function () { return view.serviceAction('restart'); }),
						' ',
						btn(_('停止服务'), 'negative', function () { return view.serviceAction('stop'); }),
						' ',
						btn(_('开机自启: 切换'), 'button', function () { return view.toggleAutostart(); })
					])
				]),
				E('div', { class: 'cbi-value' }, [
					E('div', { class: 'cbi-value-field' }, [
						E('a', {
							class: 'cbi-button cbi-button-action',
							href: 'http://' + window.location.hostname + ':9090/ui/',
							target: '_blank',
							rel: 'noreferrer'
						}, _('打开 Web 控制台 (Zashboard) ↗'))
					])
				])
			], _('轻量裸核由 procd 托管，崩溃自动拉起')),
			card(_('监听端口'), [
				E('div', { id: 'ports-box' }, E('em', {}, _('读取中…')))
			], _('透明代理走 eBPF（br-lan TC 钩子），不依赖 TUN / nftables 劫持')),
			card(_('基础信息'), [
				E('table', { class: 'table' }, [
					E('tr', { class: 'tr' }, [ E('td', { class: 'td', width: '30%' }, _('内核版本')), E('td', { id: 'info-version', class: 'td' }, '—') ]),
					E('tr', { class: 'tr' }, [ E('td', { class: 'td' }, _('生效节点数')), E('td', { id: 'info-proxies', class: 'td' }, '—') ]),
					E('tr', { class: 'tr' }, [ E('td', { class: 'td' }, _('订阅更新时间')), E('td', { id: 'info-updated', class: 'td' }, '—') ]),
					E('tr', { class: 'tr' }, [ E('td', { class: 'td' }, _('配置覆写 (mixin)')), E('td', { id: 'info-mixin', class: 'td' }, '—') ]),
					E('tr', { class: 'tr' }, [ E('td', { class: 'td' }, _('配置文件')), E('td', { class: 'td' }, '/etc/mihomo/config.yaml') ]),
					E('tr', { class: 'tr' }, [ E('td', { class: 'td' }, _('日志文件')), E('td', { class: 'td' }, '/var/log/mihomo/core.log') ])
				])
			])
		]);

		/* ---- Tab 2 订阅与覆写 ---- */
		panels.sub = E('div', { id: 'tab-sub', style: 'display:none' }, [
			card(_('节点订阅'), [
				row(_('订阅链接 (Sub URL)'),
					E('input', { id: 'in-suburl', class: 'cbi-input-text', style: 'width:100%', type: 'text', value: '' }),
					_('支持本地 Sub-Store 链接或任意 Clash / Mihomo 订阅地址')),
				row(_('启用配置覆写 (Mixin)'),
					E('select', { id: 'in-mixinen', class: 'cbi-input-select' }, [
						E('option', { value: '1' }, _('启用（更新订阅时自动合并 mixin.yaml）')),
						E('option', { value: '0' }, _('停用（仅使用远端订阅原样配置）'))
					])),
				E('div', { class: 'cbi-value' }, [
					E('div', { class: 'cbi-value-field' }, [
						btn(_('保存订阅设置'), 'apply', function () { return view.saveSubSettings(); }),
						' ',
						btn(_('立即更新订阅（下载 + 合并 + 热重载）'), 'action', function (ev) { return view.doUpdateSub(ev.target); })
					])
				])
			], _('更新后经 mihomo -t 校验，通过则 REST 热重载，无需重启断网')),
			card(_('配置覆写 (Mixin) — 基础参数 / DNS / 策略组 / 分流规则'), [
				E('textarea', {
					id: 'in-mixin-head',
					class: 'cbi-input-textarea',
					spellcheck: 'false',
					rows: 22,
					style: 'width:100%;font-family:monospace;font-size:12px'
				}, ''),
				E('div', { class: 'cbi-value' }, [
					E('div', { class: 'cbi-value-field' }, [
						btn(_('保存覆写内容'), 'apply', function () { return view.saveMixinHead(); }),
						' ',
						btn(_('仅应用覆写（不重新下载订阅）'), 'action', function (ev) { return view.applyMixin(ev.target); })
					])
				])
			], _('编辑 /etc/mihomo/mixin.yaml 的上半部分（服务端入站请在「服务端」页签编辑）')),
			card(_('最近订阅操作日志'), [
				pre('sub-log-mini', 200)
			])
		]);

		/* ---- Tab 3 服务端 ---- */
		panels.server = E('div', { id: 'tab-server', style: 'display:none' }, [
			card(_('局域网共享 (Allow LAN)'), [
				row(_('允许局域网连接'),
					E('select', { id: 'in-allowlan', class: 'cbi-input-select' }, [
						E('option', { value: 'true' }, _('开启')),
						E('option', { value: 'false' }, _('关闭'))
					])),
				row(_('混合代理端口 (HTTP + SOCKS5)'),
					E('input', { id: 'in-mixedport', class: 'cbi-input-text', type: 'text', value: '7893' }),
					_('局域网设备将代理服务器填为 192.168.5.1:此端口 即可走代理')),
				row(_('HTTP 代理端口 (port)'),
					E('input', { id: 'in-httpport', class: 'cbi-input-text', type: 'text', value: '8090' }),
					_('留空则不开放独立 HTTP 入站')),
				row(_('SOCKS5 代理端口 (socks-port)'),
					E('input', { id: 'in-socksport', class: 'cbi-input-text', type: 'text', value: '1080' }),
					_('留空则不开放独立 SOCKS5 入站')),
				row(_('监听地址 (bind-address)'),
					E('input', { id: 'in-bindaddr', class: 'cbi-input-text', type: 'text', value: '*' })),
				row(_('代理鉴权 (用户名:密码，每行一个，留空为不鉴权)'),
					E('textarea', { id: 'in-auth', class: 'cbi-input-textarea', rows: 3, style: 'width:100%;font-family:monospace' }, ''))
			]),
			card(_('入站监听 (listeners) — 把本机作为代理节点'), [
				E('div', { id: 'listeners-summary', style: 'margin-bottom:10px' }, ''),
				E('textarea', {
					id: 'in-listeners',
					class: 'cbi-input-textarea',
					spellcheck: 'false',
					rows: 18,
					style: 'width:100%;font-family:monospace;font-size:12px'
				}, ''),
				E('div', { class: 'cbi-value' }, [
					E('div', { class: 'cbi-value-field' }, [
						btn(_('保存并热应用服务端设置'), 'apply', function () { return view.saveServer(); })
					])
				])
			], _('必须保留 ebpf-in (透明代理入口)，切勿添加 local: 或 tun: 块')),
			card(_('监听端口实测'), [
				E('div', { id: 'ports-box2' }, E('em', {}, _('读取中…')))
			])
		]);

		/* ---- Tab 4 内核与面板 ---- */
		panels.core = E('div', { id: 'tab-core', style: 'display:none' }, [
			card(_('Mihomo 内核'), [
				row(_('当前版本'), E('em', { id: 'core-cur-ver' }, '—')),
				row(_('更新源'), E('div', {}, [
					E('code', {}, 'github.com/liuran001/mihomo'),
					E('div', { class: 'cbi-value-description' },
						_('滚动预发布 tag：Prerelease-Alpha。该仓库没有正式 release，GitHub 的 releases/latest 对它返回 404，必须按 tag 取资产列表后再拼接下载地址。'))
				])),
				row(_('远端可用版本'), E('em', { id: 'core-remote-ver' }, _('点「检查更新」拉取'))),
				row(_('远端资产'), E('code', { id: 'core-remote-asset' }, '—')),
				row(_('本地备份'), E('em', { id: 'core-bak' }, '—'), _('更新前自动备份到 /usr/bin/mihomo.bak')),
				E('div', { class: 'cbi-value' }, [
					E('div', { class: 'cbi-value-field' }, [
						btn(_('检查更新'), 'action', function () { return view.checkCore(); }),
						' ',
						btn(_('更新内核'), 'apply', function (ev) { return view.updateCore(ev.target); }),
						' ',
						btn(_('更新分流规则库'), 'action', function () { return view.doAction('update_rules', 120000); }),
						' ',
						btn(_('回滚备份内核'), 'button', function () { return view.doAction('rollback_core'); })
					])
				])
			], _('下载 arm64 二进制更新内核；点击「更新分流规则库」可独立无损热刷新全部 22 个上游规则集；任一环节失败均不影响在跑服务')),
			card(_('Web 控制台面板'), [
				row(_('面板目录'), E('code', {}, '/etc/mihomo/ui')),
				E('div', { class: 'cbi-value' }, [
					E('div', { class: 'cbi-value-field' }, [
						btn(_('检查并在线更新面板'), 'action', function () { return view.doAction('update_ui', 120000); })
					])
				])
			], _('更新源：github.com/Zephyruso/zashboard')),
			card(_('操作输出'), [ pre('core-out', 200) ])
		]);

		/* ---- Tab 5 日志 ---- */
		panels.logs = E('div', { id: 'tab-logs', style: 'display:none' }, [
			card(_('运行日志'), [
				E('div', { class: 'cbi-value' }, [
					E('div', { class: 'cbi-value-field' }, [
						E('select', { id: 'in-logwhich', class: 'cbi-input-select' }, [
							E('option', { value: 'core' }, _('核心运行日志 (core.log)')),
							E('option', { value: 'sub' }, _('订阅/重载日志 (sub.log)'))
						]),
						' ',
						E('select', { id: 'in-lognum', class: 'cbi-input-select' }, [
							E('option', { value: '100' }, '100 行'),
							E('option', { value: '200' }, '200 行'),
							E('option', { value: '500' }, '500 行'),
							E('option', { value: '1000' }, '1000 行')
						]),
						' ',
						btn(_('刷新'), 'action', function () { return view.refreshLog(true); }),
						' ',
						btn(_('复制'), 'button', function () { return view.copyLog(); }),
						' ',
						btn(_('清空'), 'negative', function () { return view.clearLog(); })
					])
				]),
				pre('log-view', 460),
				E('div', { class: 'cbi-value-description' }, _('日志自动轮转，单文件上限约 1MB；每 8 秒自动刷新'))
			])
		]);

		var container = E('div', {}, [
			E('h2', {}, [ 'Mihomo 极简代理 ', E('span', { class: 'cbi-section-descr' }, '(Mihomo Lite · 裸核)') ]),
			E('div', { class: 'cbi-section-descr', style: 'margin-bottom:12px' },
				_('ImmortalWRT · JDCloud RE-SS-01 (aarch64) · eBPF 纯透明代理 + DoH DNS + 原生服务端入站')),
			tabbar,
			panels.overview, panels.sub, panels.server, panels.core, panels.logs
		]);

		/*
		 * 注意：必须在容器真正挂到 #view 之后才初始化各面板。
		 * View.__init__ 的流程是 load() -> render() -> DOM.content(#view, 返回值)，
		 * 所以 render() 内 getElementById 拿不到任何节点，统一放到 mounted() 里跑。
		 */
		window.setTimeout(function () { view.mounted(); }, 0);

		/*
		 * 轮询策略（省开销）：
		 *  - 状态/端口 15 秒一次（原 5 秒），且只在「运行状态」「服务端」页签 + 页面可见时才跑；
		 *  - 日志 10 秒一次，只在「运行日志」页签 + 页面可见时才跑；
		 *  - 页面切到后台（document.hidden）完全不发请求；
		 *  - 内容没变化就不重绘 DOM；
		 *  - 每次轮询只发 1 个 ubus 请求（overview 一次给齐状态+端口，原先要 2 个）。
		 */
		poll.add(function () { return view.pollStatus(); }, 15);
		poll.add(function () {
			if (S.tab !== 'logs' || document.hidden) return Promise.resolve();
			return view.refreshLog(false);
		}, 10);

		return container;
	},

	mounted: function () {
		this.fillSub();
		this.fillServer();
		this.updateStatusUI();
		this.switchTab('overview');
		this.refreshLog(true);
	},

	/* ---------------- 页签 ---------------- */

	switchTab: function (id) {
		S.tab = id;
		['overview', 'sub', 'server', 'core', 'logs'].forEach(function (t) {
			var el = document.getElementById('tab-' + t);
			if (el) el.style.display = (t === id) ? '' : 'none';
		});
		if (id === 'logs') this.refreshLog(true);
	},

	/* ---------------- 状态 ---------------- */

	refreshStatus: function () {
		var view = this;
		/* 一次 overview 同时拿状态与端口 */
		return ctlJson(['overview']).then(function (r) {
			if (r && r.status) {
				S.status = r.status;
				S.ports = r.ports || [];
				view.updateStatusUI();
			}
			return S.status;
		}).catch(function () { return S.status; });
	},

	pollStatus: function () {
		if (document.hidden) return Promise.resolve();
		if (S.tab === 'overview' || S.tab === 'server') return this.refreshStatus();
		return Promise.resolve();
	},

	updateStatusUI: function () {
		var st = S.status || {};
		var running = st.running === true;

		/* 状态签名：只有真正变了才重建 DOM（内存取 0.5MB 粒度，保证数值仍会更新） */
		var sig = [
			running, st.pid, Math.round((st.mem_kb || 0) / 512), st.uptime,
			st.version, st.proxies_count, st.updated_at, st.mixin_enabled, st.core_backup,
			JSON.stringify(S.ports)
		].join('|');
		if (sig === S.sig) return;
		S.sig = sig;

		var color = running ? 'green' : 'red';
		setHTML('status-line', '<span style="color:%s"><strong>%s</strong></span> %s'.format(
			color,
			running ? _('● 运行中') : _('○ 已停止'),
			running
				? '(PID %s · %s · 已运行 %s)'.format(st.pid || '—', fmtSize(st.mem_kb), fmtUptime(st.uptime))
				: ''
		));

		setText('info-version', st.version || '—');
		setText('info-proxies', (st.proxies_count != null ? String(st.proxies_count) + ' ' + _('个节点') : '—'));
		setText('info-updated', st.updated_at || '—');
		setText('info-mixin', st.mixin_enabled === '1' ? _('已启用') : _('已停用'));
		setText('core-cur-ver', st.version || '—');
		setText('core-bak', st.core_backup ? _('存在 /usr/bin/mihomo.bak') : _('不存在'));

		var names = {
			9090: _('REST API 控制端口'),
			7893: _('混合代理 (HTTP+SOCKS5)'),
			8090: _('HTTP 代理入站'),
			1080: _('SOCKS5 代理入站'),
			1053: _('Mihomo DNS'),
			8080: _('入站 VLESS-WS'),
			8081: _('入站 VLESS-TLS'),
			36712: _('入站 Hysteria2')
		};
		var html = '<table class="table"><tr class="tr">' + Object.keys(names).map(function (p) {
			return '<th class="th">%s</th>'.format(p);
		}).join('') + '</tr><tr class="tr">';

		var map = {};
		(S.ports || []).forEach(function (p) { map[p.port] = p.listen; });
		html += Object.keys(names).map(function (p) {
			var on = map[p] === true;
			return '<td class="td"><span style="color:%s">%s</span></td>'.format(on ? 'green' : 'red', on ? '✔ ' + _('监听') : '✘ ' + _('未监听'));
		}).join('') + '</tr><tr class="tr">';

		html += Object.keys(names).map(function (p) {
			return '<td class="td" style="font-size:11px">%s</td>'.format(names[p]);
		}).join('') + '</tr></table>';

		setHTML('ports-box', html);
		setHTML('ports-box2', html);

		/* 端口状态变了顺手刷新服务端页签的监听汇总（仅在该页签可见时） */
		if (S.tab === 'server') this.renderListenerSummary();
	},

	serviceAction: function (action) {
		var view = this;
		return sh(INITD, [action]).then(function () {
			return view.refreshStatus();
		}).then(function () {
			notify(_('服务 %s 已执行').format(action), 'info');
		}).catch(function (e) {
			notify(_('操作失败：%s').format(e.message || e), 'error');
		});
	},

	toggleAutostart: function () {
		var view = this;
		return ctlJson(['toggle_autostart']).then(function (r) {
			notify(r.msg || (r.ok ? _('已切换') : _('失败')), r.ok ? 'info' : 'error');
			return view.refreshStatus();
		}).catch(function (e) {
			notify(_('切换失败：%s').format(e.message || e), 'error');
		});
	},

	/* ---------------- 订阅与覆写 ---------------- */

	fillSub: function () {
		var st = S.status || {};
		document.getElementById('in-suburl').value = st.sub_url || '';
		document.getElementById('in-mixinen').value = (st.mixin_enabled === '0') ? '0' : '1';
		document.getElementById('in-mixin-head').value = S.head;
	},

	saveSubSettings: function () {
		var view = this;
		var url = document.getElementById('in-suburl').value.trim();
		var en = document.getElementById('in-mixinen').value;
		if (!url) {
			notify(_('订阅链接不能为空'), 'error');
			return Promise.resolve();
		}
		return ctlJson(['set_sub', url, en]).then(function (r) {
			notify(r.msg || (r.ok ? _('已保存') : _('失败')), r.ok ? 'info' : 'error');
			return view.refreshStatus();
		}).catch(function (e) {
			notify(_('保存失败：%s').format(e.message || e), 'error');
		});
	},

	saveMixinHead: function () {
		var head = document.getElementById('in-mixin-head').value.replace(/\r\n/g, '\n');
		if (!/\n$/.test(head)) head += '\n';
		S.head = head;
		return fs.write(MIXIN, S.head + S.listeners).then(function () {
			notify(_('覆写内容已保存，点击「仅应用覆写」使其生效'), 'info');
		}).catch(function (e) {
			notify(_('写入失败：%s').format(e.message || e), 'error');
		});
	},

	doUpdateSub: function (btnEl) {
		var view = this;
		if (btnEl) btnEl.disabled = true;
		setText('sub-log-mini', _('正在下载订阅并合并…（约 15-30 秒，请勿关闭页面）'));
		return ctlLongJson(['update_sub']).then(function (r) {
			notify(r.msg || (r.ok ? _('完成') : _('失败')), r.ok ? 'info' : 'error');
			return view.refreshLog(true);
		}).then(function () {
			return view.reloadMixin();
		}).then(function () {
			return view.refreshStatus();
		}).catch(function (e) {
			notify(_('更新失败：%s').format(e.message || e), 'error');
		}).finally(function () {
			if (btnEl) btnEl.disabled = false;
		});
	},

	applyMixin: function (btnEl) {
		var view = this;
		if (btnEl) btnEl.disabled = true;
		setText('sub-log-mini', _('正在重新合并并热应用…'));
		return ctlLongJson(['apply_mixin']).then(function (r) {
			notify(r.msg || (r.ok ? _('完成') : _('失败')), r.ok ? 'info' : 'error');
			return view.refreshLog(true);
		}).then(function () {
			return view.refreshStatus();
		}).catch(function (e) {
			notify(_('应用失败：%s').format(e.message || e), 'error');
		}).finally(function () {
			if (btnEl) btnEl.disabled = false;
		});
	},

	reloadMixin: function () {
		return fs.read(MIXIN).then(function (txt) {
			var sp = splitMixin(txt);
			S.head = sp.head;
			S.listeners = sp.listeners;
			document.getElementById('in-mixin-head').value = S.head;
			document.getElementById('in-listeners').value = S.listeners;
		}).catch(function () { /* ignore */ });
	},

	/* ---------------- 服务端 ---------------- */

	fillServer: function () {
		var mb = managedBlock(S.head);
		var allow = getKey(mb, 'allow-lan', 'true');
		var mixed = getKey(mb, 'mixed-port', '7893');
		var http = getKey(mb, 'port', '8090');
		var socks = getKey(mb, 'socks-port', '1080');
		var bind = getKey(mb, 'bind-address', '*');

		document.getElementById('in-allowlan').value = (allow === 'true') ? 'true' : 'false';
		document.getElementById('in-mixedport').value = mixed;
		document.getElementById('in-httpport').value = http;
		document.getElementById('in-socksport').value = socks;
		document.getElementById('in-bindaddr').value = bind;

		var authLines = [];
		var authIdx = mb.indexOf('authentication:');
		if (authIdx >= 0) {
			mb.slice(authIdx).split('\n').slice(1).some(function (l) {
				var mm = /^[ \t]+-[ \t]*["']?(.*?)["']?[ \t]*$/.exec(l);
				if (mm) { authLines.push(mm[1]); return false; }
				return l.trim() !== '';
			});
		}
		document.getElementById('in-auth').value = authLines.join('\n');
		document.getElementById('in-listeners').value = S.listeners;

		this.renderListenerSummary();
	},

	renderListenerSummary: function () {
		var list = parseListeners(S.listeners);
		if (!list.length) {
			setHTML('listeners-summary', '<em>%s</em>'.format(_('未解析到监听器')));
			return;
		}
		var html = '<table class="table"><tr class="tr"><th class="th">%s</th><th class="th">%s</th><th class="th">%s</th><th class="th">%s</th></tr>'
			.format(_('名称'), _('协议'), _('端口'), _('状态'));
		var map = {};
		(S.ports || []).forEach(function (p) { map[p.port] = p.listen; });
		list.forEach(function (l) {
			var on = l.port ? (map[parseInt(l.port)] === true) : null;
			var st = (on === null) ? '—' : (on ? _('✔ 监听中') : _('✘ 未监听'));
			var col = (on === null) ? '' : (on ? 'green' : 'red');
			html += '<tr class="tr"><td class="td">%s</td><td class="td">%s</td><td class="td">%s</td><td class="td"><span style="color:%s">%s</span></td></tr>'
				.format(l.name, l.type || '—', l.port || '—', col, st);
		});
		html += '</table>';
		setHTML('listeners-summary', html);
	},

	saveServer: function () {
		var view = this;
		var allow = document.getElementById('in-allowlan').value;
		var mixed = document.getElementById('in-mixedport').value.trim();
		var http = document.getElementById('in-httpport').value.trim();
		var socks = document.getElementById('in-socksport').value.trim();
		var bind = document.getElementById('in-bindaddr').value.trim() || '*';
		var authRaw = document.getElementById('in-auth').value.replace(/\r\n/g, '\n').trim();
		var listeners = document.getElementById('in-listeners').value.replace(/\r\n/g, '\n');

		if (!/^listeners:/.test(listeners.trim())) {
			notify(_('入站监听内容必须以 listeners: 开头'), 'error');
			return Promise.resolve();
		}
		if (!/^\s*-\s*name:\s*ebpf-in/m.test(listeners)) {
			notify(_('警告：入站监听中缺少 ebpf-in，透明代理将失效！已阻止保存。'), 'error');
			return Promise.resolve();
		}
		if (mixed !== '' && !/^\d+$/.test(mixed)) {
			notify(_('混合端口必须是数字'), 'error');
			return Promise.resolve();
		}
		if ((http !== '' && !/^\d+$/.test(http)) || (socks !== '' && !/^\d+$/.test(socks))) {
			notify(_('HTTP / SOCKS5 端口必须是数字（留空表示不开放）'), 'error');
			return Promise.resolve();
		}

		var body = [
			'allow-lan: ' + allow,
			'bind-address: "' + bind + '"',
			'mixed-port: ' + (mixed || '7893')
		];
		if (http) body.push('port: ' + http);
		if (socks) body.push('socks-port: ' + socks);
		if (authRaw) {
			body.push('authentication:');
			authRaw.split('\n').forEach(function (l) {
				if (l.trim() !== '') body.push('  - "' + l.trim() + '"');
			});
		}
		body.push('');

		S.head = replaceManaged(S.head, body);
		S.listeners = listeners;
		if (!/\n$/.test(S.listeners)) S.listeners += '\n';

		return fs.write(MIXIN, S.head + S.listeners).then(function () {
			document.getElementById('in-mixin-head').value = S.head;
			return ctlJson(['apply_mixin']);
		}).then(function (r) {
			notify(r.msg || (r.ok ? _('已热应用') : _('应用失败')), r.ok ? 'info' : 'error');
			return view.refreshStatus();
		}).then(function () {
			view.renderListenerSummary();
		}).catch(function (e) {
			notify(_('保存失败：%s').format(e.message || e), 'error');
		});
	},

	/* ---------------- 内核 / 面板 ---------------- */

	doAction: function (cmd, timeoutMs) {
		var view = this;
		var el = document.getElementById('core-out');
		if (el) el.textContent = _('执行中，请稍候…（%s）').format(cmd);
		return ctlJson([cmd]).then(function (r) {
			if (el) el.textContent = JSON.stringify(r, null, 2);
			notify(r.msg || (r.ok ? _('完成') : _('失败')), r.ok ? 'info' : 'error');
			return view.refreshStatus();
		}).catch(function (e) {
			if (el) el.textContent = String(e.message || e);
			notify(_('执行失败：%s').format(e.message || e), 'error');
		});
	},

	renderCoreInfo: function (r) {
		if (!r) return;
		if (r.current) setText('core-cur-ver', r.current);
		if (r.remote) {
			setText('core-remote-ver', r.remote + (r.has_update ? _('  ← 有新版本') : _('  （与当前一致）')));
		}
		setText('core-remote-asset', r.asset || '—');
		if (r.core_backup != null) {
			setText('core-bak', r.core_backup ? _('存在 /usr/bin/mihomo.bak') : _('不存在'));
		}
	},

	checkCore: function () {
		var view = this;
		setText('core-out', _('正在向 GitHub 查询最新构建…'));
		return ctlJson(['core_info']).then(function (r) {
			view.renderCoreInfo(r);
			setText('core-out', JSON.stringify(r, null, 2));

			if (!r.has_update) {
				notify(_('已是最新内核（%s）').format(r.current || '—'), 'info');
				return;
			}

			/* 发现新版本：直接弹窗问是否更新 */
			return ui.showModal(_('发现新内核'), [
				E('table', { class: 'table' }, [
					E('tr', { class: 'tr' }, [
						E('td', { class: 'td', width: '35%' }, _('当前版本')),
						E('td', { class: 'td' }, E('code', {}, r.current || '—'))
					]),
					E('tr', { class: 'tr' }, [
						E('td', { class: 'td' }, _('远端版本')),
						E('td', { class: 'td' }, E('code', {}, r.remote || '—'))
					]),
					E('tr', { class: 'tr' }, [
						E('td', { class: 'td' }, _('远端资产')),
						E('td', { class: 'td' }, E('code', {}, r.asset || '—'))
					])
				]),
				E('p', { class: 'cbi-value-description' },
					_('更新流程：下载 → gzip 校验 → 试运行 -v → 备份旧版 → 替换并重启。失败会自动放弃，不影响正在运行的内核。')),
				E('p', {}, _('是否立即更新？')),
				E('div', { class: 'right' }, [
					btn(_('取消'), 'button', function () { ui.hideModal(); }),
					' ',
					btn(_('立即更新'), 'apply', function () {
						ui.hideModal();
						return view.updateCore();
					})
				])
			]);
		}).catch(function (e) {
			setText('core-out', String(e.message || e));
			notify(_('查询失败：%s').format(e.message || e), 'error');
		});
	},

	updateCore: function (btnEl) {
		var view = this;
		var el = document.getElementById('core-out');
		var done = false;
		if (btnEl) btnEl.disabled = true;
		if (el) el.textContent = _('正在解析下载地址并下载内核（约 20–60 秒，请勿关闭页面）…');
		return ctlLongJson(['update_core']).then(function (r) {
			if (el) el.textContent = JSON.stringify(r, null, 2);
			notify(r.msg || (r.ok ? _('完成') : _('失败')), r.ok ? 'info' : 'error');
			done = (r.ok === true && r.updated === true);
			return view.refreshStatus();
		}).then(function () {
			if (!done) return null;
			/* 更新成功：静默刷新远端信息（不再弹窗） */
			return ctlJson(['core_info']).then(function (r) {
				view.renderCoreInfo(r);
				setText('core-out', JSON.stringify(r, null, 2));
			}).catch(function () { /* 忽略 */ });
		}).catch(function (e) {
			if (el) el.textContent = String(e.message || e);
			notify(_('更新失败：%s').format(e.message || e), 'error');
		}).finally(function () {
			if (btnEl) btnEl.disabled = false;
		});
	},

	/* ---------------- 日志 ---------------- */

	refreshLog: function (force) {
		var which = S.logWhich;
		var n = S.logLines;
		var sel1 = document.getElementById('in-logwhich');
		var sel2 = document.getElementById('in-lognum');
		if (sel1) { which = sel1.value; S.logWhich = which; }
		if (sel2) { n = sel2.value; S.logLines = n; }

		return ctl(['tail_log', which, n]).then(function (r) {
			var txt = String(r.stdout || '');
			var box = document.getElementById('log-view');
			/* 内容长度没变就不重绘（避免无意义的 innerHTML/滚动重排） */
			if (box && (force || txt.length !== S.logLen)) {
				S.logLen = txt.length;
				var atBottom = (box.scrollTop + box.clientHeight) >= (box.scrollHeight - 40);
				box.textContent = txt || _('（暂无日志）');
				if (atBottom) box.scrollTop = box.scrollHeight;
			}
			var mini = document.getElementById('sub-log-mini');
			if (mini && force && which === 'sub') mini.textContent = txt.slice(-4000);
			return txt;
		}).catch(function () { return ''; });
	},

	copyLog: function () {
		var box = document.getElementById('log-view');
		var txt = box ? box.textContent : '';
		if (!txt) return Promise.resolve();
		return navigator.clipboard.writeText(txt).then(function () {
			notify(_('日志已复制到剪贴板'), 'info');
		}).catch(function () {
			notify(_('复制失败，请手动选择文本'), 'error');
		});
	},

	clearLog: function () {
		var view = this;
		/* 注意：ui.showModal 的第三个参数是 CSS class 列表，按钮必须放在 children 里 */
		return ui.showModal(_('清空日志'), [
			E('p', {}, _('确定要清空所选日志文件吗？该操作不可撤销。')),
			E('div', { class: 'right' }, [
				btn(_('取消'), 'button', function () { ui.hideModal(); }),
				' ',
				btn(_('确定清空'), 'negative', function () {
					ui.hideModal();
					ctlJson(['clear_log', S.logWhich]).then(function (r) {
						notify(r.msg || _('已清空'), 'info');
						return view.refreshLog(true);
					});
				})
			])
		]);
	}
});
