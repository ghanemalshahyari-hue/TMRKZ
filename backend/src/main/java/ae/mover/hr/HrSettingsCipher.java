package ae.mover.hr;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.HexFormat;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

import org.springframework.stereotype.Component;

import ae.mover.common.ApiException;
import ae.mover.common.ErrorCode;

/**
 * Encrypts the HR source connection settings with AES-256-GCM under TMRKZ's own key ({@code TMRKZ_HR_SETTINGS_KEY}).
 * Values encrypted by another application's key are never accepted: settings migrated from TNQL are re-entered through
 * an authorised operations channel and protected here. Rotating the key makes stored settings unreadable on purpose;
 * the administrator re-enters them.
 */
@Component
public class HrSettingsCipher {

    private static final SecureRandom RANDOM = new SecureRandom();
    private final byte[] key;
    private final String keyId;

    public HrSettingsCipher(HrProperties props) {
        String material = props.settingsKey();
        if (material == null || material.length() < 32) {
            this.key = null;
            this.keyId = null;
        } else {
            this.key = sha256(("tmrkz-hr-settings:" + material).getBytes(StandardCharsets.UTF_8));
            this.keyId = HexFormat.of().formatHex(sha256(key)).substring(0, 16);
        }
    }

    public boolean configured() {
        return key != null;
    }

    public String keyId() {
        return keyId;
    }

    public String encrypt(String plaintext) {
        requireKey();
        try {
            byte[] iv = new byte[12];
            RANDOM.nextBytes(iv);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
            byte[] ct = c.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
            byte[] out = new byte[iv.length + ct.length];
            System.arraycopy(iv, 0, out, 0, iv.length);
            System.arraycopy(ct, 0, out, iv.length, ct.length);
            return "v1:" + Base64.getEncoder().encodeToString(out);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("HR settings encryption failed", e);
        }
    }

    public String decrypt(String token, String storedKeyId) {
        requireKey();
        if (token == null || !token.startsWith("v1:") || storedKeyId == null || !storedKeyId.equals(keyId)) {
            throw new ApiException(ErrorCode.HR_SOURCE_NOT_CONFIGURED,
                    "إعدادات مصدر الموارد البشرية محمية بمفتاح مختلف أو غير مكتملة؛ أعد إدخالها.");
        }
        try {
            byte[] all = Base64.getDecoder().decode(token.substring(3));
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, all, 0, 12));
            return new String(c.doFinal(all, 12, all.length - 12), StandardCharsets.UTF_8);
        } catch (GeneralSecurityException | IllegalArgumentException e) {
            throw new ApiException(ErrorCode.HR_SOURCE_NOT_CONFIGURED,
                    "تعذر فك إعدادات مصدر الموارد البشرية بالمفتاح الحالي؛ أعد إدخالها.");
        }
    }

    private void requireKey() {
        if (key == null) {
            throw new ApiException(ErrorCode.HR_SOURCE_NOT_CONFIGURED,
                    "مفتاح حماية إعدادات الموارد البشرية (TMRKZ_HR_SETTINGS_KEY) غير مهيأ في بيئة التشغيل.");
        }
    }

    private static byte[] sha256(byte[] in) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(in);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }
}
