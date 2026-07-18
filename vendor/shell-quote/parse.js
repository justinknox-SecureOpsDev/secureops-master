'use strict';

// Local reimplementation of shell-quote's `parse`, vendored because the
// upstream npm tarball is blocked by Replit's package firewall. Behavior
// follows shell-quote@1.8.x: a single-pass tokenizer that respects single
// quotes (literal), double quotes (with escapes for " \ $ ` and env
// expansion), backslash escapes, control operators, environment variable
// substitution, comments, and glob detection.

var TOKEN = '';
for (var i = 0; i < 4; i++) {
	TOKEN += (Math.pow(16, 8) * Math.random()).toString(16);
}
var startsWithToken = new RegExp('^' + TOKEN);

// Control operators, longest first so multi-char operators win.
var OPS = ['<<<', '||', '&&', ';;', '|&', '<(', '>>', '>&', '<&', '&', ';', '(', ')', '|', '<', '>'];

function getVar(env, pre, key) {
	var r = typeof env === 'function' ? env(key) : env[key];
	if (typeof r === 'undefined' && key !== '') {
		r = '';
	} else if (typeof r === 'undefined') {
		r = '$';
	}

	if (typeof r === 'object') {
		return pre + TOKEN + JSON.stringify(r) + TOKEN;
	}
	return pre + r;
}

function parseInternal(s, env, opts) {
	if (!env) {
		env = {};
	}
	if (!opts) {
		opts = {};
	}
	var BS = opts.escape || '\\';

	var out = [];
	var n = s.length;
	var i = 0;

	var token = '';
	var hasToken = false; // a token was started (covers empty quotes like '')
	var isGlob = false;

	function pushToken() {
		if (hasToken) {
			if (isGlob) {
				out.push({ op: 'glob', pattern: token });
			} else {
				out.push(token);
			}
		}
		token = '';
		hasToken = false;
		isGlob = false;
	}

	function matchOp(pos) {
		for (var k = 0; k < OPS.length; k++) {
			if (s.substr(pos, OPS[k].length) === OPS[k]) {
				return OPS[k];
			}
		}
		return null;
	}

	// Parse an environment variable starting at the '$' located at `pos`.
	// Returns { value, next }.
	function parseEnvAt(pos) {
		var j = pos + 1;
		var ch = s.charAt(j);
		var varname;

		if (ch === '{') {
			j += 1;
			if (s.charAt(j) === '}') {
				throw new Error('Bad substitution: ' + s.slice(pos, j + 1));
			}
			var end = s.indexOf('}', j);
			if (end < 0) {
				throw new Error('Bad substitution: ' + s.slice(pos));
			}
			varname = s.slice(j, end);
			j = end + 1;
		} else if ((/[*@#?$!_-]/).test(ch)) {
			varname = ch;
			j += 1;
		} else {
			var rest = s.slice(j);
			var m = rest.match(/[^\w\d_]/);
			if (!m) {
				varname = rest;
				j = s.length;
			} else {
				varname = rest.slice(0, m.index);
				j += m.index;
			}
		}
		return { value: getVar(env, '', varname), next: j };
	}

	while (i < n) {
		var c = s.charAt(i);

		// Unquoted whitespace separates tokens.
		if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
			pushToken();
			i += 1;
			continue;
		}

		// A '#' that begins a token starts a comment that runs to end of input.
		if (c === '#' && !hasToken) {
			out.push({ comment: s.slice(i + 1) });
			i = n;
			break;
		}

		// Control operators break the current token.
		var op = matchOp(i);
		if (op !== null) {
			pushToken();
			out.push({ op: op });
			i += op.length;
			continue;
		}

		// Backslash escape outside quotes.
		if (c === BS) {
			hasToken = true;
			i += 1;
			if (i < n) {
				token += s.charAt(i);
				i += 1;
			}
			continue;
		}

		// Single quotes: everything literal up to the next single quote.
		if (c === "'") {
			hasToken = true;
			i += 1;
			while (i < n && s.charAt(i) !== "'") {
				token += s.charAt(i);
				i += 1;
			}
			i += 1; // skip closing quote
			continue;
		}

		// Double quotes: escapes for " \ $ ` and environment expansion.
		if (c === '"') {
			hasToken = true;
			i += 1;
			while (i < n && s.charAt(i) !== '"') {
				var d = s.charAt(i);
				if (d === BS) {
					var nx = s.charAt(i + 1);
					if (nx === '"' || nx === BS || nx === '$' || nx === '`') {
						token += nx;
						i += 2;
					} else {
						token += BS;
						i += 1;
					}
				} else if (d === '$') {
					var de = parseEnvAt(i);
					token += de.value;
					i = de.next;
				} else {
					token += d;
					i += 1;
				}
			}
			i += 1; // skip closing quote
			continue;
		}

		// Unquoted environment variable.
		if (c === '$') {
			var ue = parseEnvAt(i);
			hasToken = true;
			token += ue.value;
			i = ue.next;
			continue;
		}

		// Unquoted glob characters mark the token as a glob pattern.
		if (c === '*' || c === '?') {
			isGlob = true;
		}

		hasToken = true;
		token += c;
		i += 1;
	}
	pushToken();

	return out;
}

module.exports = function (s, env, opts) {
	var mapped = parseInternal(s, env, opts);
	if (typeof env !== 'function') {
		return mapped;
	}
	return mapped.reduce(function (acc, entry) {
		if (typeof entry === 'object') {
			return acc.concat(entry);
		}
		var xs = entry.split(new RegExp('(' + TOKEN + '.*?' + TOKEN + ')', 'g'));
		if (xs.length === 1) {
			return acc.concat(xs[0]);
		}
		return acc.concat(xs.filter(Boolean).map(function (x) {
			if (startsWithToken.test(x)) {
				return JSON.parse(x.split(TOKEN)[1]);
			}
			return x;
		}));
	}, []);
};
