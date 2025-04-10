/**
 * Generates a data URI containing synthetic sniff data.
 * This function creates a string representing sample sniff data, encodes it, and returns a data URI.
 *
 * @returns {string} A valid data URI with Base64-encoded sniff data.
 */
function generateSniffDataURI(): string {
    // Define sample sniff data. This is synthetic data for testing purposes.
    const sniffData = `----- BEGIN SNIFF DATA -----
  Timestamp: 2025-04-10 14:25:30.123456
  Source: 192.168.1.100:54321
  Destination: 104.16.123.96:80
  Protocol: TCP
  Flags: SYN, ACK
  Payload:
     GET / HTTP/1.1\r\n
     Host: example.com\r\n
     User-Agent: TestAgent/1.0\r\n
     Accept: */*\r\n
     Connection: keep-alive\r\n
     \r\n
  ----- END SNIFF DATA -----`;
  
    // Encode the sample data to Base64.
    const base64Data = Buffer.from(sniffData, 'utf-8').toString('base64');
  
    // Construct the data URI with the MIME type set to plain text.
    const dataUri = `data:text/plain;base64,${base64Data}`;
  
    return dataUri;
  }
  
  // Example usage: Generate the data URI and print it.
  const sniffDataURI = generateSniffDataURI();
  console.log("Generated Sniff Data URI:\n", sniffDataURI);
  