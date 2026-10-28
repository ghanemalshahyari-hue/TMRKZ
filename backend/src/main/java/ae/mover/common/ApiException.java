package ae.mover.common;

import java.util.Map;

/** Business error with a stable machine code and an Arabic message safe to show to the caller. */
public class ApiException extends RuntimeException {

    private final ErrorCode code;
    private final Map<String, Object> details;

    public ApiException(ErrorCode code, String message) {
        this(code, message, Map.of());
    }

    public ApiException(ErrorCode code, String message, Map<String, Object> details) {
        super(message);
        this.code = code;
        this.details = details == null ? Map.of() : details;
    }

    public ErrorCode code() {
        return code;
    }

    public Map<String, Object> details() {
        return details;
    }

    public static ApiException notFound() {
        return new ApiException(ErrorCode.RESOURCE_NOT_FOUND, "العنصر المطلوب غير موجود أو خارج نطاق صلاحياتك.");
    }

    public static ApiException forbidden(String message) {
        return new ApiException(ErrorCode.FORBIDDEN, message);
    }

    public static ApiException forbidden() {
        return forbidden("لا تملك صلاحية تنفيذ هذا الإجراء.");
    }

    public static ApiException validation(String message) {
        return new ApiException(ErrorCode.VALIDATION_FAILED, message);
    }

    public static ApiException validation(String message, Map<String, Object> details) {
        return new ApiException(ErrorCode.VALIDATION_FAILED, message, details);
    }

    public static ApiException staleRevision() {
        return new ApiException(ErrorCode.STALE_REVISION,
                "تم تعديل هذا الطلب بعد آخر تحميل. أعد تحميل الطلب ثم كرر الإجراء على أحدث نسخة.");
    }
}
