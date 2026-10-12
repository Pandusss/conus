#!/usr/bin/env node
import { greet } from '../src/greet.js';

const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith('--')) ?? 'world';
console.log(greet(name));
