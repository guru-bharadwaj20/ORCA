#!/usr/bin/env node
const { program } = require('commander');

program.command('seed').action(() => run());
program.parse();
