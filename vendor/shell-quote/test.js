'use strict';

// Parity tests for the vendored shell-quote reimplementation. Expected values
// are taken from upstream shell-quote@1.8.x behavior. Run with: node test.js

var assert = require('assert');
var quote = require('./quote');
var parse = require('./parse');

function eq(actual, expected, label) {
	assert.deepStrictEqual(actual, expected, label + '\n  actual:   ' + JSON.stringify(actual) + '\n  expected: ' + JSON.stringify(expected));
	console.log('ok - ' + label);
}

// --- quote ---
eq(quote(['a', 'b', 'c']), 'a b c', "quote simple");
eq(quote(['a', 'b c', 'd']), "a 'b c' d", "quote arg with space");
eq(quote(['']), "''", "quote empty string");
eq(quote(["it's"]), '"it\'s"', "quote arg with single quote");
eq(quote(['a\\b']), 'a\\\\b', "quote arg with backslash");
eq(quote([{ op: '|' }]), '\\|', "quote op object");
eq(quote(['$HOME']), '\\$HOME', "quote dollar sign");

// --- parse: quoting keeps spaces together (the bug that was fixed) ---
eq(parse('a "b c" d'), ['a', 'b c', 'd'], "parse double-quoted span with space");
eq(parse("a 'b c' d"), ['a', 'b c', 'd'], "parse single-quoted span with space");
eq(parse('a b\\ c'), ['a', 'b c'], "parse escaped space");

// --- parse: control operators ---
eq(parse('a | b'), ['a', { op: '|' }, 'b'], "parse pipe");
eq(parse('a && b'), ['a', { op: '&&' }, 'b'], "parse and-and (single op)");
eq(parse('a <<< b'), ['a', { op: '<<<' }, 'b'], "parse here-string (single op)");
eq(parse('a <& b'), ['a', { op: '<&' }, 'b'], "parse <& (single op)");

// --- parse: environment variables ---
eq(parse('echo $HOME', { HOME: '/home/me' }), ['echo', '/home/me'], "parse env var");
eq(parse('echo "${X}y"', { X: 'a' }), ['echo', 'ay'], "parse braced env var in double quotes");
eq(parse("echo '$HOME'", { HOME: '/home/me' }), ['echo', '$HOME'], "parse single quotes do not expand");

// --- parse: glob detection ---
eq(parse('ls *.js'), ['ls', { op: 'glob', pattern: '*.js' }], "parse unquoted glob");
eq(parse('ls "*.js"'), ['ls', '*.js'], "parse quoted glob is literal");

// --- parse: comments ---
eq(parse('beep #boop'), ['beep', { comment: 'boop' }], "parse comment");

console.log('\nAll parity tests passed.');
