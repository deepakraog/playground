import * as fs from 'fs';
import * as mime from 'mime-types';

/**
 * Options for generating data URIs
 */
export interface DataUriOptions {
  mimeType?: string;
  encoding?: 'base64' | 'utf8';
  prefix?: string;
}

/**
 * Generates a data URI from a file
 */
export function generateDataUri(
  filePath: string, 
  options?: DataUriOptions
): string {
  const fileContent = fs.readFileSync(filePath);
  const mimeType = options?.mimeType || mime.lookup(filePath) || 'application/octet-stream';
  const encoding = options?.encoding || 'base64';
  const prefix = options?.prefix || 'data:';
  
  // Get the raw base64 encoded data without any additional formatting
  const encodedData = encoding === 'base64' 
    ? fileContent.toString('base64')
    : encodeURIComponent(fileContent.toString('utf8'));
    
  // Format according to: data:[<media-type>][;base64],<data>
  return `${prefix}${mimeType};${encoding},${encodedData}`;
}
