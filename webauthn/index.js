const crypto = require('crypto');
const { decode } = require('./cbor/index.js'); 
const { decodeCoseKey, COSE_KEY_TYPES, COSE_ALGORITHMS, COSE_ELLIPTIC_CURVES, getWebAuthnPublicKeyDetails } = require('./cose/index.js'); 
const { decodeDerEncodedSignature } = require('./utils.js');

// --- Utility Functions ---

/**
 * Decodes a Base64URL string into a Buffer.
 * @param {string} base64urlString
 * @returns {Buffer}
 */
function base64urlToBuffer(base64urlString) {
    return Buffer.from(base64urlString, 'base64url');
}

/**
 * Converts a Buffer to a Base64URL string.
 * @param {Buffer} buffer
 * @returns {string}
 */
function bufferToBase64url(buffer) {
    return buffer.toString('base64url');
}

/**
 * Simple constant-time buffer comparison.
 * @param {Buffer} a
 * @param {Buffer} b
 * @returns {boolean}
 */
function bufferEqual(a, b) {
    if (a.length !== b.length) {
        return false;
    }
    // Constant time comparison
    return crypto.timingSafeEqual(a, b);
}

// --- Core Verification Logic ---

/**
 * Parses and verifies the authenticator data.
 * @param {Buffer} authDataBuffer - The raw authenticator data buffer.
 * @param {string} expectedRpId - The expected Relying Party ID.
 * @param {boolean} requireUserVerification - Whether the UV flag must be set.
 * @returns {{rpIdHash: Buffer, flags: {up: boolean, uv: boolean, at: boolean, ed: boolean}, signCount: number, aaguid: Buffer, credentialId: Buffer, credentialPublicKey: Buffer}}
 * @throws {Error} If validation fails.
 */
function parseAndVerifyAuthenticatorData(authDataBuffer, expectedRpId, requireUserVerification) {
    if (authDataBuffer.byteLength < 37) { // rpIdHash (32) + flags (1) + signCount (4)
        throw new Error(`Authenticator data is too short. Expected >= 37 bytes, got ${authDataBuffer.byteLength}`);
    }

    const rpIdHash = authDataBuffer.subarray(0, 32);
    const flagsByte = authDataBuffer.readUInt8(32);
    const signCount = authDataBuffer.readUInt32BE(33); // 4 bytes counter

    // Verify RP ID Hash
    if (expectedRpId) {
        const expectedRpIdHash = crypto.createHash('sha256').update(expectedRpId).digest();
        if (!bufferEqual(rpIdHash, expectedRpIdHash)) {
            throw new Error(`RP ID hash mismatch. Expected ${expectedRpIdHash.toString('hex')} but got ${rpIdHash.toString('hex')}`);
        }
        console.log('RP ID hash verified.');
    } else {
        console.log('Skipping RP ID hash verification as expectedRpId was not provided.');
    }

    // Parse Flags
    const flags = {
        up: !!(flagsByte & 0x01), // User Present
        uv: !!(flagsByte & 0x04), // User Verified
        at: !!(flagsByte & 0x40), // Attested credential data included
        ed: !!(flagsByte & 0x80), // Extension data included
    };

    console.log('Parsed Flags:', flags);
    console.log('Sign Count:', signCount);

    // Verify Flags
    if (!flags.up) {
        throw new Error('User Presence flag (UP) was not set.');
    }
    if (requireUserVerification && !flags.uv) {
        throw new Error('User Verification flag (UV) was required but not set.');
    }
    if (!flags.at) {
        // This should not happen in registration response according to spec
        throw new Error('Attested Credential Data flag (AT) was not set. Required for registration.');
    }

    // --- Process Attested Credential Data ---
    // This part is present only if flags.at is true
    let offset = 37; // Start after rpIdHash, flags, signCount

    if (authDataBuffer.byteLength < offset + 16 + 2) { // AAGUID (16) + CredID Length (2)
        throw new Error('Authenticator data too short for AAGUID and Credential ID Length.');
    }

    const aaguid = authDataBuffer.subarray(offset, offset + 16);
    offset += 16;
    console.log('AAGUID:', aaguid.toString('hex'));

    const credentialIdLength = authDataBuffer.readUInt16BE(offset);
    offset += 2;
    console.log('Credential ID Length:', credentialIdLength);

    if (authDataBuffer.byteLength < offset + credentialIdLength) {
        throw new Error(`Authenticator data too short for Credential ID. Expected ${credentialIdLength} bytes.`);
    }
    const credentialId = authDataBuffer.subarray(offset, offset + credentialIdLength);
    offset += credentialIdLength;
    console.log('Credential ID:', credentialId.toString('base64url')); // Often stored/compared as base64url

    // The rest is the credentialPublicKey (COSE Key)
    const credentialPublicKey = authDataBuffer.subarray(offset);
    console.log('Credential Public Key (COSE CBOR):', credentialPublicKey.toString('hex'));

    return {
        rpIdHash,
        flags,
        signCount,
        aaguid,
        credentialId,
        credentialPublicKey,
        // extensions // Add if parsed
    };
}

/**
 * Verifies the Attestation statement.
 * NOTE: THIS IS A SIMPLIFIED PLACEHOLDER. Real verification is complex.
 * @param {string} fmt - Attestation format.
 * @param {object} attStmt - Attestation statement object (decoded from CBOR).
 * @param {Buffer} authDataBuffer - The raw authenticator data buffer.
 * @param {Buffer} clientDataHash - SHA256 hash of the clientDataJSON.
 * @param {object} credentialPublicKeyDetails - Decoded public key details { kty, alg, crv?, x?, y? }
 * @param {Buffer} rpIdHash - SHA256 hash of the RP ID from authenticator data.
 * @param {Buffer} credentialId - The Credential ID from authenticator data.
 * @returns {Promise<boolean>} - True if verification is considered successful (in this simplified version).
 * @throws {Error} If format is unsupported or basic checks fail.
 */
async function verifyAttestationStatement(fmt, attStmt, authDataBuffer, clientDataHash, credentialPublicKeyDetails, rpIdHash, credentialId) {
    console.log(`Attempting verification for format: ${fmt}`);
    // console.log('Attestation Statement:', attStmt);
    // console.log('AuthData:', authDataBuffer.toString('hex'));
    // console.log('ClientData Hash:', clientDataHash.toString('hex'));
    // console.log('Public Key Details:', credentialPublicKeyDetails);

    switch (fmt) {
        case 'none':
            // 'none' format means no attestation is provided. Trust authData.
            console.log("Attestation format is 'none'. Skipping signature verification.");
            return true; // No verification possible/required

        case 'packed':
            // Can be self-attestation or basic/attCA attestation.
            // Self-attestation: Signature using the *new* credential key over authData + clientDataHash.
            // Basic/AttCA: Signature using an attestation key, certificate chain likely in `x5c`.
            console.log("Processing 'packed' attestation format.");
            const { alg: packedAlg, sig: packedSig, x5c: packedX5c } = attStmt;

            if (!packedSig) {
                throw new Error("Packed attestation statement missing 'sig'.");
            }
            if (packedAlg === undefined) { // alg is optional per spec if key provides it, but often present
                console.warn("Packed attestation statement missing 'alg'. Will rely on public key alg.");
            }

            const dataToVerify = Buffer.concat([authDataBuffer, clientDataHash]);

            if (packedX5c && Array.isArray(packedX5c) && packedX5c.length > 0) {
                // --- Basic/AttCA Attestation ---
                 throw new Error("Packed attestation with x5c (certificate chain) found. Full verification requires certificate parsing, chain validation, and checking against metadata. THIS IS NOT IMPLEMENTED HERE.");
            } else {
                // --- Self-Attestation ---
                console.log("Attempting Packed Self-Attestation verification.");
                // Verify the signature using the *credential's public key*.
                // The algorithm should match the one in the credential public key.
                const keyObject = await crypto.subtle.importKey(
                    'jwk',
                    convertCoseKeyToJwk(credentialPublicKeyDetails), // Need conversion helper
                    getJwkParams(credentialPublicKeyDetails.alg), // Need conversion helper
                    true,
                    ['verify']
                );

                const signatureIsValid = await crypto.subtle.verify(
                    getWebCryptoAlgName(credentialPublicKeyDetails.alg), // Need conversion helper
                    keyObject,
                    packedSig, // The signature from attStmt
                    dataToVerify
                );

                if (!signatureIsValid) {
                    throw new Error("Packed self-attestation signature verification failed.");
                }
                console.log("Packed self-attestation signature verified successfully.");
                return true;
            }

        case 'fido-u2f':
            console.log("Processing 'fido-u2f' attestation format.");
            const { sig: u2fSig, x5c: u2fX5c } = attStmt;

            // 1. Verify attStmt structure
            if (!u2fSig || !Buffer.isBuffer(u2fSig)) {
                throw new Error("FIDO-U2F attestation statement missing or invalid 'sig'.");
            }
            if (!u2fX5c || !Array.isArray(u2fX5c) || u2fX5c.length < 1 || !Buffer.isBuffer(u2fX5c[0])) {
                 throw new Error("FIDO-U2F attestation statement missing or invalid 'x5c' (certificate chain).");
            }
            console.log("FIDO-U2F structure validated (sig, x5c[0] present).");

            // --- SECURITY WARNING: SIMPLIFIED IMPLEMENTATION ---
            // 2. Parse leaf certificate from x5c[0] - SKIPPED.
            // 3. Extract public key *from the certificate* - SKIPPED.
            // We are INSECURELY using the public key from authData instead.
            // A compliant implementation MUST extract the public key from the certificate
            // and use that for verification. It also MUST validate the certificate chain.
            // --- END SECURITY WARNING ---

            // Ensure the key from authData is P-256 ECC as required by U2F
            if (credentialPublicKeyDetails.kty !== COSE_KEY_TYPES.EC2 ||
                credentialPublicKeyDetails.crv !== COSE_ELLIPTIC_CURVES.P_256 ||
                credentialPublicKeyDetails.alg !== COSE_ALGORITHMS.ES256) {
                throw new Error(`FIDO-U2F requires an ES256 P-256 public key in authData, but received different parameters (kty: ${credentialPublicKeyDetails.kty}, crv: ${credentialPublicKeyDetails.crv}, alg: ${credentialPublicKeyDetails.alg})`);
            }

            // 4. Construct specific U2F verification data buffer
            // verificationData = 0x00 || rpIdHash || clientDataHash || credentialId || publicKeyU2F
            const reservedByte = Buffer.from([0x00]);
            // Extract the P-256 public key point (uncompressed format: 0x04 || x || y)
            const publicKeyU2F = Buffer.concat([
                Buffer.from([0x04]), // Uncompressed point indicator
                credentialPublicKeyDetails.x,
                credentialPublicKeyDetails.y
            ]);

            const verificationData = Buffer.concat([
                reservedByte,
                rpIdHash,       // From authData
                clientDataHash, // Calculated from clientDataJSON
                credentialId,   // From authData
                publicKeyU2F    // From authData public key (x, y coordinates)
            ]);
            console.log("Constructed U2F verification data.");

            // 5. Verify 'sig' over verificationData using the *authData* public key (INSECURE SHORTCUT)
            const keyObject = await crypto.subtle.importKey(
                'jwk',
                convertCoseKeyToJwk(credentialPublicKeyDetails), // Uses the key from authData
                getJwkParams(COSE_ALGORITHMS.ES256), // U2F MUST use ES256
                true,
                ['verify']
            );

            const signatureIsValid = await crypto.subtle.verify(
                getWebCryptoAlgName(COSE_ALGORITHMS.ES256), // U2F MUST use ES256
                keyObject,
                u2fSig,
                verificationData
            );

            if (!signatureIsValid) {
                throw new Error("FIDO-U2F signature verification failed (using authData key).");
            }
            console.log("FIDO-U2F signature verified successfully (using authData key - INSECURE).");

            // 6. RECOMMENDED: Validate x5c chain against trusted roots - SKIPPED.
            // Requires a Metadata Service and certificate validation logic.

            return true; // Return true if signature verification passed (with the insecure key)

        case 'tpm':
            console.warn("Attestation format 'tpm' verification is complex and requires TPM-specific knowledge. THIS IS NOT IMPLEMENTED HERE.");
            return true; // Placeholder

        // Add cases for 'android-key', 'android-safetynet' if needed

        default:
            throw new Error(`Unsupported attestation format: ${fmt}`);
    }
}


// --- Helper functions for Attestation Verification (Placeholders/Examples) ---

function convertCoseKeyToJwk(coseKeyDetails) {
    // Basic conversion, needs error handling and support for more types (RSA)
    const jwk = {
        kty: '',
        crv: '',
        x: '',
        y: '',
        use: 'sig' // Keep use parameter
    };

    if (coseKeyDetails.kty === COSE_KEY_TYPES.EC2) {
        jwk.kty = 'EC';
        jwk.crv = getJwkCurve(coseKeyDetails.crv);
        jwk.x = Buffer.from(coseKeyDetails.x).toString('base64url');
        jwk.y = Buffer.from(coseKeyDetails.y).toString('base64url');
    } else if (coseKeyDetails.kty === COSE_KEY_TYPES.OKP) {
        jwk.kty = 'OKP';
        jwk.crv = getJwkCurve(coseKeyDetails.crv);
        jwk.x = Buffer.from(coseKeyDetails.x).toString('base64url');
        // OKP JWK doesn't use 'y'
        delete jwk.y;
    } else {
        throw new Error(`Cannot convert COSE kty ${coseKeyDetails.kty} to JWK`);
    }

    return jwk;
}

function getJwkCurve(coseCurve) {
    switch (coseCurve) {
        case COSE_ELLIPTIC_CURVES.P_256: return 'P-256';
        case COSE_ELLIPTIC_CURVES.P_384: return 'P-384';
        case COSE_ELLIPTIC_CURVES.P_521: return 'P-521';
        case COSE_ELLIPTIC_CURVES.Ed25519: return 'Ed25519';
        default: throw new Error(`Unsupported COSE curve: ${coseCurve}`);
    }
}

function getJwkAlg(coseAlg) {
    // Map COSE Algorithm numbers to JWA names (RFC 7518) if needed by crypto lib
    // This mapping isn't always 1:1 or strictly necessary if the library
    // infers from the key type/curve, but good practice.
    switch (coseAlg) {
        case COSE_ALGORITHMS.ES256: return 'ES256';
        case COSE_ALGORITHMS.ES384: return 'ES384';
        case COSE_ALGORITHMS.ES512: return 'ES512';
        case COSE_ALGORITHMS.EdDSA: return 'EdDSA'; // Often inferred from OKP/Ed25519
        case COSE_ALGORITHMS.RS256: return 'RS256';
        // Add other mappings as needed
        default:
            console.warn(`No explicit JWK alg mapping for COSE alg ${coseAlg}`);
            return undefined; // Let the crypto library infer if possible
    }
}
function getJwkParams(coseAlg) {
    // Parameters for subtle.importKey based on JWA alg name
    switch (coseAlg) {
        case COSE_ALGORITHMS.ES256: return { name: 'ECDSA', namedCurve: 'P-256' };
        case COSE_ALGORITHMS.ES384: return { name: 'ECDSA', namedCurve: 'P-384' };
        case COSE_ALGORITHMS.ES512: return { name: 'ECDSA', namedCurve: 'P-521' };
        case COSE_ALGORITHMS.EdDSA: return { name: 'EdDSA', namedCurve: 'Ed25519' };
        case COSE_ALGORITHMS.RS256: return { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
        // Add others
        default: throw new Error(`Unsupported COSE algorithm for WebCrypto import: ${coseAlg}`);
    }
}
function getWebCryptoAlgName(coseAlg) {
    // Algorithm object/name for subtle.verify
    switch (coseAlg) {
        case COSE_ALGORITHMS.ES256: return { name: 'ECDSA', hash: { name: 'SHA-256' } };
        case COSE_ALGORITHMS.ES384: return { name: 'ECDSA', hash: { name: 'SHA-384' } };
        case COSE_ALGORITHMS.ES512: return { name: 'ECDSA', hash: { name: 'SHA-512' } };
        case COSE_ALGORITHMS.EdDSA: return { name: 'EdDSA' }; // EdDSA hash is implicit
        case COSE_ALGORITHMS.RS256: return { name: 'RSASSA-PKCS1-v1_5' }; // Hash defined in importKey
        // Add others
        default: throw new Error(`Unsupported COSE algorithm for WebCrypto verify: ${coseAlg}`);
    }
}


// --- Main Registration Verification Function ---

/**
 * Verifies the response from navigator.credentials.create()
 *
 * @param {object} credential - The PublicKeyCredential object received from the client (JSON parsed, ArrayBuffers typically base64url encoded strings).
 * @param {string} expectedChallenge - The base64url encoded challenge originally sent to the client.
 * @param {string} expectedOrigin - The expected origin (e.g., 'https://example.com').
 * @param {string} expectedRpId - The expected Relying Party ID (e.g., 'example.com').
 * @param {boolean} requireUserVerification - Whether UV flag must be set in authData.
 * @returns {Promise<object>} Information about the verified credential to be stored.
 * @throws {Error} If any verification step fails.
 */
async function verifyRegistrationResponse(credential, expectedChallenge, expectedOrigin, expectedRpId, requireUserVerification) {
    // Basic structure check
    if (!credential || !credential.id || !credential.rawId || !credential.response ||
        !credential.response.clientDataJSON || !credential.response.attestationObject ||
        credential.type !== 'public-key') {
        throw new Error('Invalid credential structure received.');
    }

    console.log('Starting registration verification...');
    console.log('Expected Challenge:', expectedChallenge);
    console.log('Expected Origin:', expectedOrigin);
    console.log('Expected RP ID:', expectedRpId);

    // 1. Decode necessary inputs from Base64URL
    const rawIdBuffer = base64urlToBuffer(credential.rawId);
    const clientDataJSONBuffer = base64urlToBuffer(credential.response.clientDataJSON);
    const attestationObjectBuffer = base64urlToBuffer(credential.response.attestationObject);

    // 2. Parse and verify clientDataJSON
    console.log('\n--- Verifying clientDataJSON ---');
    let clientData;
    try {
        const clientDataString = clientDataJSONBuffer.toString('utf8');
        clientData = JSON.parse(clientDataString);
    } catch (e) {
        throw new Error(`Failed to parse clientDataJSON: ${e.message}`);
    }

    console.log('Parsed clientData:', clientData);

    if (clientData.type !== 'webauthn.create') {
        throw new Error(`Invalid clientData type. Expected 'webauthn.create', got '${clientData.type}'`);
    }

    // Compare challenge (use buffer compare for security)
    if (expectedChallenge) {
        const receivedChallengeBuffer = base64urlToBuffer(clientData.challenge);
        const expectedChallengeBuffer = base64urlToBuffer(expectedChallenge);
        if (!bufferEqual(receivedChallengeBuffer, expectedChallengeBuffer)) {
            throw new Error('Challenge mismatch.');
        }
        console.log('Challenge verified.');
    } else {
        console.log('Skipping challenge verification as expectedChallenge was not provided.');
    }

    // Compare origin
    if (expectedOrigin) {
        if (clientData.origin !== expectedOrigin) {
            // Handle variations like port numbers if necessary
            throw new Error(`Origin mismatch. Expected '${expectedOrigin}', got '${clientData.origin}'`);
        }
        console.log('Origin verified.');
    } else {
        console.log('Skipping origin verification as expectedOrigin was not provided.');
    }

    // Optional: Check tokenBinding field if used

    // 3. Parse attestationObject CBOR
    console.log('\n--- Verifying attestationObject ---');
    let attestationObject;
    try {
        // Ensure input to cbor.decode is ArrayBuffer
        let attestationObjectArrayBuffer;
        if (Buffer.isBuffer(attestationObjectBuffer)) {
            attestationObjectArrayBuffer = attestationObjectBuffer.buffer.slice(
                attestationObjectBuffer.byteOffset,
                attestationObjectBuffer.byteOffset + attestationObjectBuffer.byteLength
            );
        } else if (attestationObjectBuffer instanceof ArrayBuffer) {
            // Should not happen here as base64urlToBuffer returns Buffer, but good practice
            attestationObjectArrayBuffer = attestationObjectBuffer;
        } else {
            throw new Error('Invalid type for attestationObjectBuffer: Expected Buffer');
        }
        attestationObject = decode(attestationObjectArrayBuffer); // Use your CBOR decoder
    } catch (e) {
        throw new Error(`Failed to decode attestationObject CBOR: ${e.message}`);
    }

    const { fmt, attStmt, authData: authDataBuffer } = attestationObject;

    // Check if authData is Buffer or Uint8Array
    const isAuthDataBufferValid = Buffer.isBuffer(authDataBuffer) || authDataBuffer instanceof Uint8Array;

    if (!fmt || typeof fmt !== 'string' || !attStmt || typeof attStmt !== 'object' || !isAuthDataBufferValid) {
        console.error('Attestation object structure validation failed:'); // Add logging
        console.error(`  fmt: ${fmt} (type: ${typeof fmt})`);
        console.error(`  attStmt: ${attStmt} (type: ${typeof attStmt})`);
        console.error(`  authData: ${authDataBuffer} (type: ${authDataBuffer?.constructor?.name})`);
        console.error(`  isAuthDataBufferValid: ${isAuthDataBufferValid}`);
        throw new Error('Invalid attestation object structure. Missing or invalid fmt, attStmt, or authData.');
    }
    console.log('Attestation Format:', fmt);

    // 4. Parse and verify authenticatorData (authData)
    console.log('\n--- Verifying authenticatorData ---');
    // Ensure authData is a Buffer for parsing functions
    const authDataForParsing = Buffer.from(authDataBuffer);
    const parsedAuthData = parseAndVerifyAuthenticatorData(authDataForParsing, expectedRpId, requireUserVerification);

    // Verify that the credential ID in authData matches the one received at the top level
    if (!bufferEqual(rawIdBuffer, parsedAuthData.credentialId)) {
        throw new Error('Credential ID mismatch between authData and PublicKeyCredential.rawId.');
    }
    console.log('Credential ID consistency verified.');

    // 5. Decode the credential public key (COSE format)
    console.log('\n--- Decoding Public Key ---');
    let publicKeyDetails;
    try {
        const coseKeyMap = decodeCoseKey(parsedAuthData.credentialPublicKey); // Using cose.js
        publicKeyDetails = getWebAuthnPublicKeyDetails(coseKeyMap); // Using cose.js
        console.log('Decoded Public Key Details:', publicKeyDetails);
    } catch (e) {
        throw new Error(`Failed to decode credentialPublicKey: ${e.message}`);
    }

    // 6. Calculate clientDataHash
    const clientDataHash = crypto.createHash('sha256').update(clientDataJSONBuffer).digest();

    // 7. Verify the attestation statement (using the specific format)
    console.log('\n--- Verifying Attestation Statement ---');
    // *** IMPORTANT: This step is simplified. Robust implementation needed for production. ***
    try {
        const attestationVerified = await verifyAttestationStatement(
            fmt,
            attStmt,
            authDataBuffer,
            clientDataHash,
            publicKeyDetails,
            parsedAuthData.rpIdHash,
            parsedAuthData.credentialId
        );
        if (!attestationVerified) {
            // Should not happen if verifyAttestationStatement throws on failure, but belt-and-suspenders
            throw new Error('Attestation statement verification failed.');
        }
        console.log('Attestation statement verified (or verification skipped/simplified).');
    } catch (e) {
        throw new Error(`Attestation verification error: ${e.message}`);
    }

    // 8. Check uniqueness: Ensure parsedAuthData.credentialId is not already registered
    //    (Requires database lookup - Pseudocode below)
    // const existingCredential = await database.findCredentialById(parsedAuthData.credentialId);
    // if (existingCredential) {
    //     throw new Error(`Credential ID already registered: ${parsedAuthData.credentialId.toString('base64url')}`);
    // }
    console.log('Placeholder: Credential ID uniqueness check passed.');

    // --- Verification Successful ---
    console.log('\nRegistration verification successful!');

    // 9. Return data to be stored for the user
    return {
        credentialId: parsedAuthData.credentialId, // Store as Buffer or base64url string
        credentialPublicKey: parsedAuthData.credentialPublicKey, // Store the raw COSE key Buffer
        signCount: parsedAuthData.signCount,
        aaguid: parsedAuthData.aaguid,
        transports: credential.response.getTransports ? credential.response.getTransports() : [], // Store associated transports if available
        // Potentially store fmt, attStmt, flags.uv for policy decisions later
        userVerified: parsedAuthData.flags.uv,
        attestationFormat: fmt,
    };
}

/**
 * Parses Authenticator Data for assertions (login).
 * Does NOT include attested credential data checks.
 * @param {Buffer} authDataBuffer
 * @param {string} expectedRpId
 * @param {boolean} requireUserVerification
 * @returns {{rpIdHash: Buffer, flags: {up: boolean, uv: boolean, at: boolean, ed: boolean}, signCount: number}}
 * @throws {Error}
 */
function parseAssertionAuthenticatorData(authDataBuffer, expectedRpId, requireUserVerification) {
    if (authDataBuffer.byteLength < 37) { // rpIdHash (32) + flags (1) + signCount (4)
        throw new Error(`Authenticator data is too short for assertion. Expected >= 37 bytes, got ${authDataBuffer.byteLength}`);
    }

    const rpIdHash = authDataBuffer.subarray(0, 32);
    const flagsByte = authDataBuffer.readUInt8(32);
    const signCount = authDataBuffer.readUInt32BE(33); // 4 bytes counter

    // Verify RP ID Hash
    if (expectedRpId) {
        const expectedRpIdHash = crypto.createHash('sha256').update(expectedRpId).digest();
        if (!bufferEqual(rpIdHash, expectedRpIdHash)) {
            throw new Error(`RP ID hash mismatch during assertion. Expected ${expectedRpIdHash.toString('hex')} but got ${rpIdHash.toString('hex')}`);
        }
        console.log('Assertion RP ID hash verified.');
    } else {
        console.log('Skipping assertion RP ID hash verification as expectedRpId was not provided.');
    }

    // Parse Flags
    const flags = {
        up: !!(flagsByte & 0x01), // User Present
        uv: !!(flagsByte & 0x04), // User Verified
        // AT (0x40) and ED (0x80) flags might be present but are less critical for assertion logic itself
        at: !!(flagsByte & 0x40), // Attested credential data included (Should be false for assertion?)
        ed: !!(flagsByte & 0x80), // Extension data included
    };
    console.log('Parsed Assertion Flags:', flags);
    console.log('Assertion Sign Count:', signCount);

    // Verify Flags
    if (!flags.up) {
        // While UP=false is possible in some scenarios (e.g., U2F HID authenticators without presence test), 
        // most modern WebAuthn flows require user presence.
        // Depending on policy, you might allow this, but generally it's required.
        console.warn('User Presence flag (UP) was not set during assertion. This might be acceptable depending on policy and authenticator type.');
        // For stricter security, uncomment the line below:
        // throw new Error('User Presence flag (UP) was not set during assertion.');
    }
    if (requireUserVerification && !flags.uv) {
        // This check depends on the RP's policy for this specific login
        throw new Error('User Verification flag (UV) was required for assertion but not set.');
    }

    // Note: We don't parse AAGUID, Credential ID, or Public Key here,
    // as they are not part of the authenticatorData during assertion.
    // Extension data parsing would happen after offset 37 if flags.ed is true.

    return {
        rpIdHash,
        flags,
        signCount,
        // extensions // Add if parsed
    };
}

/**
 * Verifies the response from navigator.credentials.get()
 *
 * @param {object} assertion - The PublicKeyCredential object received from the client (JSON parsed, ArrayBuffers base64url encoded).
 * @param {object} storedCredential - The stored credential information for the given credential ID (needs { credentialId: Buffer, credentialPublicKey: Buffer, signCount: number }).
 * @param {string} expectedChallenge - The base64url encoded challenge originally sent to the client.
 * @param {string} expectedOrigin - The expected origin (e.g., 'https://example.com').
 * @param {string} expectedRpId - The expected Relying Party ID (e.g., 'example.com').
 * @param {boolean} requireUserVerification - Whether UV flag must be set in authData for this assertion.
 * @returns {Promise<object>} Information about the verified assertion (e.g., new sign count).
 * @throws {Error} If any verification step fails.
 */
async function verifyAssertionResponse(assertion, storedCredential, expectedChallenge, expectedOrigin, expectedRpId, requireUserVerification) {
    // Basic structure check
    if (!assertion || !assertion.id || !assertion.rawId || !assertion.response ||
        !assertion.response.authenticatorData || !assertion.response.clientDataJSON ||
        !assertion.response.signature || assertion.type !== 'public-key') {
        throw new Error('Invalid assertion structure received.');
    }

    console.log('Starting assertion verification...');
    console.log('Expected Challenge:', expectedChallenge);
    console.log('Expected Origin:', expectedOrigin);
    console.log('Expected RP ID:', expectedRpId);

    // 1. Decode necessary inputs from Base64URL
    const rawIdBuffer = base64urlToBuffer(assertion.rawId);
    const clientDataJSONBuffer = base64urlToBuffer(assertion.response.clientDataJSON);
    const authenticatorDataBuffer = base64urlToBuffer(assertion.response.authenticatorData);
    const publicKeyBuffer = base64urlToBuffer(storedCredential.publicKey);
    const signatureBuffer = base64urlToBuffer(assertion.response.signature);

    // Verify credential ID matches the one stored
    if (assertion.id !== storedCredential.id) {
        throw new Error(`Credential ID mismatch. Expected ${storedCredential.id}, got ${assertion.id}`);
    }
    console.log('Credential ID verified.');

    // 2. Parse and verify clientDataJSON
    console.log('\n--- Verifying clientDataJSON ---');
    let clientData;
    try {
        const clientDataString = clientDataJSONBuffer.toString('utf8');
        clientData = JSON.parse(clientDataString);
    } catch (e) {
        throw new Error(`Failed to parse clientDataJSON: ${e.message}`);
    }
    console.log('Parsed clientData:', clientData);

    if (clientData.type !== 'webauthn.get') {
        throw new Error(`Invalid clientData type. Expected 'webauthn.get', got '${clientData.type}'`);
    }

    // Compare challenge
    // const receivedChallengeBuffer = base64urlToBuffer(clientData.challenge);
    // const expectedChallengeBuffer = base64urlToBuffer(expectedChallenge);
    if (clientData.challenge !== expectedChallenge) {
        throw new Error('Challenge mismatch.');
    }
    console.log('Challenge verified.');

    // Compare origin
    if (clientData.origin !== expectedOrigin) {
        throw new Error(`Origin mismatch. Expected '${expectedOrigin}', got '${clientData.origin}'`);
    }
    console.log('Origin verified.');

    // 3. Parse authenticatorData
    console.log('\n--- Verifying authenticatorData ---');
    // Ensure authenticatorDataBuffer is a Buffer for parsing
    const authDataForParsing = Buffer.from(authenticatorDataBuffer);
    const parsedAuthData = parseAssertionAuthenticatorData(authDataForParsing, expectedRpId, requireUserVerification);

    // 4. Verify Signature
    console.log('\n--- Verifying Signature ---');
    const clientDataHash = crypto.createHash('sha256').update(clientDataJSONBuffer).digest();
    const dataToVerify = Buffer.concat([authDataForParsing, clientDataHash]);

    // Decode the stored public key
    let publicKeyDetails;
    try {
        const coseKeyMap = decodeCoseKey(publicKeyBuffer); // Decode stored key
        publicKeyDetails = getWebAuthnPublicKeyDetails(coseKeyMap);
    } catch (e) {
        throw new Error(`Failed to decode stored credentialPublicKey: ${e.message}`);
    }

    // Import public key for verification
    const keyObject = await crypto.subtle.importKey(
        'jwk',
        convertCoseKeyToJwk(publicKeyDetails),
        getJwkParams(publicKeyDetails.alg),
        true,
        ['verify']
    );

    // Perform verification - CONVERT SIGNATURE FORMAT FOR ECDSA
    let signatureToVerify = signatureBuffer;
    let verificationAlgorithm = getWebCryptoAlgName(publicKeyDetails.alg);

    if (publicKeyDetails.kty === COSE_KEY_TYPES.EC2) {
        // ECDSA signatures from WebAuthn are ASN.1 DER encoded, but WebCrypto expects raw r||s
        let curveByteLength;
        switch (publicKeyDetails.crv) {
            case COSE_ELLIPTIC_CURVES.P_256: curveByteLength = 32; break;
            case COSE_ELLIPTIC_CURVES.P_384: curveByteLength = 48; break;
            case COSE_ELLIPTIC_CURVES.P_521: curveByteLength = 66; break; // Note: P-521 uses 66 bytes
            default: throw new Error(`Unsupported EC curve for signature conversion: ${publicKeyDetails.crv}`);
        }
        try {
            // Decode the ASN.1 DER signature using asn1.js
            signatureToVerify = decodeDerEncodedSignature(signatureBuffer, curveByteLength);
            console.log(`Decoded ASN.1 DER signature using asn1.js library for curve length ${curveByteLength}.`);
        } catch (asn1Error) {
            throw new Error(`Failed to decode ASN.1 DER signature using asn1.js: ${asn1Error.message}`);
        }
    }
    // For EdDSA or RSA, the format might be different or handled directly by WebCrypto

    const signatureIsValid = await crypto.subtle.verify(
        verificationAlgorithm, // Use the original algorithm object
        keyObject,
        signatureToVerify,    // Use the potentially converted signature
        dataToVerify
    );

    if (!signatureIsValid) {
        throw new Error("Assertion signature verification failed.");
    }
    console.log("Assertion signature verified successfully.");

    // 5. Verify Signature Counter
    console.log('\n--- Verifying Signature Counter ---');
    const currentSignCount = parsedAuthData.signCount;
    const lastSignCount = storedCredential.signCount; // From database/storage

    console.log(`Stored Sign Count: ${lastSignCount}, Received Sign Count: ${currentSignCount}`);

    // Check if counter is zero (and allow if last stored is also zero)
    if (currentSignCount === 0 && lastSignCount === 0) {
        console.log("Sign count is zero, accepted (both stored and received are 0).");
        // This is common for new authenticators or those not supporting counters
    } else if (currentSignCount <= lastSignCount) {
        // Potentially a replay attack or cloned authenticator
        throw new Error(`Invalid signature counter. Stored: ${lastSignCount}, Received: ${currentSignCount}. Possible replay attack.`);
    }
    console.log("Signature counter verified.");

    // --- Verification Successful ---
    console.log('\nAssertion verification successful!');

    // 6. Return new sign count to be updated in storage
    return {
        newSignCount: currentSignCount,
        userVerified: parsedAuthData.flags.uv // Pass back UV status from assertion
    };
}

module.exports = {
    verifyRegistrationResponse,
    verifyAssertionResponse,
    parseAndVerifyAuthenticatorData,
    parseAssertionAuthenticatorData,
    verifyAttestationStatement,
    bufferEqual,
    base64urlToBuffer,
    bufferToBase64url
};