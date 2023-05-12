export const colour = (process.env.NODE_DISABLE_COLORS || !process.stdout.isTTY) ?
    { red: '', yellow: '', green: '', blue: '', normal: '', magenta: '', grey: '', cyan: '',
        inverse: '' } :
    { red: '\x1b[31m', yellow: '\x1b[33;1m', green: '\x1b[32m', blue: '\x1b[34m', magenta: '\x1b[35m', grey: '\x1b[90m', cyan: '\x1b[96m', inverse: '\x1b[7m', normal: '\x1b[27m\x1b[0m' };

