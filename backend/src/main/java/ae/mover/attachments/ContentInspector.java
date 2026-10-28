package ae.mover.attachments;

import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.ByteBuffer;
import java.util.Locale;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

import org.springframework.stereotype.Component;

/**
 * Determines the real content type from file bytes (the client-declared type is ignored) and runs the built-in
 * content checks. An external malware scanner (e.g. ClamAV) is an integration that is not connected; the built-in
 * checks reject the EICAR test signature, macro-enabled Office content and active PDF content.
 */
@Component
public class ContentInspector {

    private static final String EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

    public record Inspection(String contentType, boolean clean, String detail) {
    }

    public Inspection inspect(String fileName, byte[] bytes) {
        String name = fileName == null ? "" : fileName.toLowerCase(Locale.ROOT);
        String type = sniff(name, bytes);
        if (type == null) {
            return new Inspection("application/octet-stream", false, "نوع الملف غير مدعوم أو لا يطابق امتداده.");
        }
        String head = new String(bytes, 0, Math.min(bytes.length, 1 << 20), StandardCharsets.ISO_8859_1);
        if (head.contains(EICAR)) {
            return new Inspection(type, false, "فشل الفحص: تم رصد توقيع اختبار برمجيات خبيثة (EICAR).");
        }
        if (type.equals("application/pdf") && (head.contains("/JavaScript") || head.contains("/Launch"))) {
            return new Inspection(type, false, "فشل الفحص: ملف PDF يحتوي محتوى نشطاً (JavaScript/Launch).");
        }
        if (type.startsWith("application/vnd.openxmlformats")) {
            try (ZipInputStream zip = new ZipInputStream(new java.io.ByteArrayInputStream(bytes))) {
                ZipEntry e;
                int entries = 0;
                while ((e = zip.getNextEntry()) != null) {
                    if (++entries > 2000) {
                        return new Inspection(type, false, "فشل الفحص: بنية الملف غير اعتيادية.");
                    }
                    if (e.getName().toLowerCase(Locale.ROOT).contains("vbaproject")) {
                        return new Inspection(type, false, "فشل الفحص: الملف يحتوي وحدات ماكرو.");
                    }
                }
            } catch (Exception ex) {
                return new Inspection(type, false, "فشل الفحص: تعذر قراءة الملف المضغوط.");
            }
        }
        return new Inspection(type, true, "اجتاز الفحص المدمج (التحقق من النوع والتوقيعات المعروفة).");
    }

    private static String sniff(String name, byte[] b) {
        if (startsWith(b, "%PDF-".getBytes(StandardCharsets.US_ASCII)) && name.endsWith(".pdf")) {
            return "application/pdf";
        }
        if (startsWith(b, new byte[]{(byte) 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A}) && name.endsWith(".png")) {
            return "image/png";
        }
        if (startsWith(b, new byte[]{(byte) 0xFF, (byte) 0xD8, (byte) 0xFF}) && (name.endsWith(".jpg") || name.endsWith(".jpeg"))) {
            return "image/jpeg";
        }
        if (startsWith(b, new byte[]{'P', 'K', 3, 4})) {
            if (name.endsWith(".docx")) {
                return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
            }
            if (name.endsWith(".xlsx")) {
                return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
            }
            return null;
        }
        if ((name.endsWith(".txt") || name.endsWith(".csv")) && isUtf8Text(b)) {
            return "text/plain";
        }
        return null;
    }

    private static boolean startsWith(byte[] b, byte[] prefix) {
        if (b.length < prefix.length) {
            return false;
        }
        for (int i = 0; i < prefix.length; i++) {
            if (b[i] != prefix[i]) {
                return false;
            }
        }
        return true;
    }

    private static boolean isUtf8Text(byte[] b) {
        for (int i = 0; i < Math.min(b.length, 8192); i++) {
            if (b[i] == 0) {
                return false;
            }
        }
        try {
            StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(b));
            return true;
        } catch (CharacterCodingException e) {
            return false;
        }
    }
}
