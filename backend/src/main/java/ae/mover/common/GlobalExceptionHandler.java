package ae.mover.common;

import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.MissingRequestHeaderException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.multipart.MaxUploadSizeExceededException;
import org.springframework.web.multipart.support.MissingServletRequestPartException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

import io.micrometer.core.instrument.MeterRegistry;

@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);
    private final MeterRegistry meters;

    public GlobalExceptionHandler(MeterRegistry meters) {
        this.meters = meters;
    }

    @ExceptionHandler(ApiException.class)
    public ResponseEntity<ErrorResponse> api(ApiException e) {
        meters.counter("mover.api.errors", "code", e.code().name()).increment();
        if (e.code() == ErrorCode.FORBIDDEN) {
            log.info("Authorization denied: {}", e.getMessage());
        }
        return respond(e.code(), e.getMessage(), e.details());
    }

    @ExceptionHandler({HttpMessageNotReadableException.class, MissingServletRequestParameterException.class,
            MethodArgumentTypeMismatchException.class, MissingServletRequestPartException.class,
            MissingRequestHeaderException.class, IllegalArgumentException.class})
    public ResponseEntity<ErrorResponse> badRequest(Exception e) {
        return respond(ErrorCode.VALIDATION_FAILED, "صيغة الطلب غير صحيحة أو ناقصة.", Map.of());
    }

    @ExceptionHandler(MaxUploadSizeExceededException.class)
    public ResponseEntity<ErrorResponse> tooLarge(MaxUploadSizeExceededException e) {
        return respond(ErrorCode.VALIDATION_FAILED, "حجم الملف يتجاوز الحد المسموح.", Map.of());
    }

    @ExceptionHandler({NoResourceFoundException.class, HttpRequestMethodNotSupportedException.class})
    public ResponseEntity<ErrorResponse> notFound(Exception e) {
        return respond(ErrorCode.RESOURCE_NOT_FOUND, "المسار غير موجود.", Map.of());
    }

    /** The database refuses changes to fields that come from HR (trigger {@code hr_fields_read_only}). */
    @ExceptionHandler(org.springframework.dao.DataAccessException.class)
    public ResponseEntity<ErrorResponse> data(org.springframework.dao.DataAccessException e) {
        String cause = e.getMostSpecificCause().getMessage();
        if (cause != null && cause.contains("HR_FIELD_READ_ONLY")) {
            return respond(ErrorCode.HR_FIELD_READ_ONLY,
                    "هذه البيانات مصدرها الموارد البشرية وتُحدّث بالمزامنة فقط؛ استخدم الإضافات المحلية للاسم المعروض والوسوم.", Map.of());
        }
        return unexpected(e);
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ErrorResponse> unexpected(Exception e) {
        log.error("Unhandled error", e);
        return respond(ErrorCode.INTERNAL_ERROR, "حدث خطأ غير متوقع في الخادم. لم يُسجل أي إجراء جزئي.", Map.of());
    }

    private ResponseEntity<ErrorResponse> respond(ErrorCode code, String message, Map<String, Object> details) {
        return ResponseEntity.status(code.status())
                .body(new ErrorResponse(code.name(), message, details, MDC.get("traceId")));
    }
}
