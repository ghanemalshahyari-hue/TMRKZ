package ae.mover.common;

import java.util.List;

public record PageResult<T>(List<T> items, int page, int size, long total) {

    public static int size(Integer requested) {
        if (requested == null || requested <= 0) {
            return 50;
        }
        return Math.min(requested, 200);
    }

    public static int page(Integer requested) {
        return requested == null || requested < 0 ? 0 : requested;
    }
}
