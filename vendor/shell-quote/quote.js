'use strict';

// Local reimplementation of shell-quote's `quote`, vendored because the
// upstream npm tarball is blocked by Replit's package firewall. Behavior
// follows shell-quote@1.8.x.

module.exports = function quote(xs) {
	return xs.map(function (s) {
		if (s && typeof s === 'object') {
			return s.op.replace(/(.)/g, '\\$1');
		}
		if (typeof s === 'string' && !s) {
			return "''";
		}
		if ((/["\s]/).test(s) && !(/'/).test(s)) {
			return "'" + s.replace(/(['\\])/g, '\\$1') + "'";
		}
		if ((/["'\s]/).test(s)) {
			return '"' + s.replace(/(["\\$`!])/g, '\\$1') + '"';
		}
		return String(s).replace(/([A-Za-z]:)?([#!"$&'()*,:;<=>?@[\\\]^`{|}])/g, '$1\\$2');
	}).join(' ');
};
