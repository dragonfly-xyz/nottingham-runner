import { toBytes, toHex, Hex } from "viem";
import crypto, { KeyObject } from "crypto";
import { promisify } from "util";

// Player bytecode is prefixed with their address and symmetrically encrypted using a
// player-chosen AES-128 key.
// The AES key is asymmetrically encrypted using the season's public key.

export interface EncryptedCodeSubmission {
    encryptedAesKey: Hex;
    encryptedCode: Hex;
    iv: Hex;
}

export interface SeasonKeys {
    publicKey: Hex;
    privateKey: Hex;
} 

export function createSeasonKeys(): SeasonKeys {
    const k = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
    return {
        publicKey: encodeJwk(k.publicKey),
        privateKey: encodeJwk(k.privateKey),
    };
}

export function decryptPlayerCode(
    seasonPrivateKey: Hex,
    playerAddress: Hex,
    submission: EncryptedCodeSubmission,
): Hex {
    const aesKey = crypto.privateDecrypt(
        {
            key: decodePrivateKey(seasonPrivateKey),
            oaepHash: 'sha256',
        },
        toBytes(submission.encryptedAesKey),
    );
    if (aesKey.length !== 16) {
        throw new Error(`invalid aes key`);
    }
    const decipher = crypto.createDecipheriv('aes-128-gcm', aesKey, toBytes(submission.iv));
    const dec = decipher.update(toBytes(submission.encryptedCode));
    // Code must be prefixed with the player address.
    if (!dec.subarray(0, 20).equals(toBytes(playerAddress))) {
        throw new Error(`invalid code`);
    }
    return toHex(dec.subarray(20));
}

export const encryptPlayerCode = webEncryptPlayerCode;

export async function nativeEncryptPlayerCode(
    seasonPublicKey: Hex,
    playerAddress: Hex,
    plainCode: Hex,
): Promise<EncryptedCodeSubmission> {
    // Code must be prefixed with the player address.
    const prefixedCode = Buffer.concat([toBytes(playerAddress), toBytes(plainCode)]);
    // 1. Create a random symmetric encryption key.
    // 2. Encrypt code with the symmetric key.
    // 3. Encrypt the symmetric key with the season's public key.
    const aesKey = await promisify(crypto.generateKey)('aes', { length: 128 });
    const encryptedAesKey = crypto.publicEncrypt(
        {
            key: decodePublicKey(seasonPublicKey),
            oaepHash: 'sha256',
        },
        aesKey.export(),
        
    );
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-128-gcm', aesKey, iv);
    const encryptedCode = cipher.update(prefixedCode);
    return {
        encryptedAesKey: toHex(encryptedAesKey),
        encryptedCode: toHex(encryptedCode),
        iv: toHex(iv),
    };
}

export async function webEncryptPlayerCode(
    seasonPublicKey: Hex,
    playerAddress: Hex,
    plainCode: Hex,
): Promise<EncryptedCodeSubmission> {
    // Code must be prefixed with the player address.
    const prefixedCode = Buffer.concat([toBytes(playerAddress), toBytes(plainCode)]);
    // 1. Create a random symmetric encryption key.
    // 2. Encrypt code with the symmetric key.
    // 3. Encrypt the symmetric key with the season's public key.
    const aesKey = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 128 },
        true,
        ['encrypt', 'decrypt'],
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encryptedCode = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        aesKey,
        prefixedCode,
    );
    const encryptedAesKey = await crypto.subtle.encrypt(
        { name: 'RSA-OAEP' },
        await crypto.subtle.importKey(
            'jwk',
            decodeJwk(seasonPublicKey),
            { name: 'RSA-OAEP', hash: 'SHA-256' },
            false,
            ['encrypt'],
        ),
        await crypto.subtle.exportKey('raw', aesKey),
    );
    return {
        encryptedAesKey: toHex(new Uint8Array(encryptedAesKey)),
        encryptedCode: toHex(new Uint8Array(encryptedCode).slice(0, -16)),
        iv: toHex(iv),
    };
}

export function deriveSeasonPublicKey(seasonPrivateKey: Hex): Hex {
    return encodeJwk(crypto.createPublicKey(decodePrivateKey(seasonPrivateKey)));
}

function decodeJwk(jwk: Hex): crypto.JsonWebKey {
    return JSON.parse(Buffer.from(toBytes(jwk)).toString());
}

function encodeJwk(key: KeyObject): Hex {
    return toHex(Buffer.from(JSON.stringify(key.export({ format: 'jwk' }))));
}

function decodePrivateKey(jwk: Hex): crypto.KeyObject {
    return crypto.createPrivateKey({ key: decodeJwk(jwk), format: 'jwk' });
}

function decodePublicKey(jwk: Hex): crypto.KeyObject {
    return crypto.createPublicKey({ key: decodeJwk(jwk), format: 'jwk' });
}