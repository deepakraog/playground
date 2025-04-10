#!/usr/bin/env node

import { Command } from 'commander';
import { generateDataUri } from './index';
import * as fs from 'fs';

const program = new Command();

program
  .name('data-uri')
  .description('Generate data URIs from files')
  .version('1.0.0');

program
  .argument('<file>', 'File to convert to data URI')
  .option('-m, --mime-type <type>', 'Specify MIME type (overrides auto-detection)')
  .option('-e, --encoding <encoding>', 'Encoding to use (base64 or utf8)', 'base64')
  .option('-p, --prefix <prefix>', 'Custom prefix instead of "data:"')
  .option('-o, --output <file>', 'Output file (if not specified, prints to stdout)')
  .action((file, options) => {
    try {
      if (!fs.existsSync(file)) {
        console.error(`Error: File "${file}" does not exist`);
        process.exit(1);
      }

      const dataUri = generateDataUri(file, {
        mimeType: options.mimeType,
        encoding: options.encoding as 'base64' | 'utf8',
        prefix: options.prefix
      });

      console.log(`Generated Data URI: ${dataUri}`);
      // Don't validate with regex, just ensure we're outputting exactly what the user wants
      
      if (options.output) {
        fs.writeFileSync(options.output, dataUri);
        console.log(`Data URI written to ${options.output}`);
      } else {
        // Just output the raw data URI without any extra processing
        process.stdout.write(dataUri);
      }
    } catch (error) {
      console.error('Error:', (error as Error).message);
      process.exit(1);
    }
  });

program.parse();
