process.env.APP_ROLE ??= 'worker';
await import('../main.ts');

export {};
