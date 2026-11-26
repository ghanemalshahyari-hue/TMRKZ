package ae.mover.security;

import java.time.Clock;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ae.mover.access.AccessContext;
import ae.mover.access.Permission;
import ae.mover.audit.AuditService;
import ae.mover.authz.UnitMemberService;
import ae.mover.common.ApiException;

/**
 * «اربط بالتطبيق» (ADR-092 companion, owner 26 Nov 2026). Connects a directory user to the app for real: the same person and
 * identity link a first sign-in would make ({@link IdentityService#resolve} — an HR record under Oracle, otherwise a LOCAL record
 * linked by the directory's stable identifier), then placed in their unit. The unit is matched by its ID first (the placement the
 * sign-in itself derives); when no Unit ID is stated or it matches no unit, by the unit NAME, Arabic-normalized, and only when it
 * names exactly one active unit. No role is granted. An ambiguous or unknown unit leaves the person connected but unplaced, and
 * says so. Configuration AND access management over everything.
 */
@Service
public class DirectoryConnectService {

    /** The outcome shown to whoever connects the user. {@code matchedBy}: ID, NAME, AMBIGUOUS or NONE. */
    public record ConnectResult(boolean ok, String message, String personId, String displayName, String employeeNumber,
                                String username, String unitName, String matchedBy) {
    }

    private final IntegrationSettingsService settings;
    private final DirectoryAuthenticator directory;
    private final IdentityService identities;
    private final EmploymentContextResolver employment;
    private final UnitMemberService units;
    private final OidcProperties oidc;
    private final AuditService audit;
    private final JdbcClient jdbc;
    private final Clock clock;

    public DirectoryConnectService(IntegrationSettingsService settings, DirectoryAuthenticator directory, IdentityService identities,
                                   EmploymentContextResolver employment, UnitMemberService units, OidcProperties oidc,
                                   AuditService audit, JdbcClient jdbc, Clock clock) {
        this.settings = settings;
        this.directory = directory;
        this.identities = identities;
        this.employment = employment;
        this.units = units;
        this.oidc = oidc;
        this.audit = audit;
        this.jdbc = jdbc;
        this.clock = clock;
    }

    @Transactional
    public ConnectResult connect(AccessContext ctx, IntegrationSettingsService.Directory form, String login, String password) {
        ctx.require(Permission.CONFIGURE);
        if (!ctx.canEverywhere(Permission.MANAGE_ACCESS)) {
            throw ApiException.forbidden("يربط المستخدمين بالتطبيق مدير صلاحيات عام فقط.");
        }
        if (login == null || login.isBlank()) {
            throw ApiException.validation("اكتب اسم دخول المستخدم المراد ربطه.");
        }
        LdapProperties p = settings.toLdap(form, settings.storedDirectoryPassword());
        DirectoryAuthenticator.DirectoryUser u;
        try {
            u = directory.read(p, login, password);
        } catch (DirectoryAuthenticator.DirectoryException e) {
            throw ApiException.validation(describe(e));
        }

        // the same person + identity link a first sign-in makes (the fromDirectory pattern): the directory profile, including the
        // stated Unit ID and unit name, is recorded by resolve() so placement by Unit ID is derived everywhere afterwards.
        OidcClient.Identity id = new OidcClient.Identity(directory.issuer(), u.uuid(),
                "EMPLOYEE_NUMBER".equals(oidc.linkKey()) ? u.employeeNumber() : u.username(), u.displayName(), u.username(),
                clock.instant(), null, "DIRECTORY_CONNECT", "/", null, false, u.profile());
        UUID person = identities.resolve(id);

        // place in the unit: by Unit ID first (already derived), else by unit name (Arabic-normalized, exactly one active unit)
        String matchedBy;
        UUID unit = employment.unitById(u.profile().unitId());
        if (unit != null) {
            matchedBy = "ID";
        } else {
            EmploymentContextResolver.UnitNameMatch m = employment.matchUnitByName(u.profile().unitName());
            if (m.count() == 1) {
                units.place(ctx, m.org(), person);
                unit = m.org();
                matchedBy = "NAME";
            } else if (m.count() > 1) {
                matchedBy = "AMBIGUOUS";
            } else {
                matchedBy = "NONE";
            }
        }
        String unitName = unit == null ? null
                : jdbc.sql("select name from organization where id = :id").param("id", unit).query(String.class).optional().orElse(null);

        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("matchedBy", matchedBy);
        detail.put("unitStatedId", u.profile().unitId());
        detail.put("unitStatedName", u.profile().unitName());
        detail.put("unitResolved", unit != null);
        audit.recordAs(ctx.actor(), "DIRECTORY_USER_CONNECTED", "PERSON", person.toString(), u.displayName(), detail, null);

        String message = switch (matchedBy) {
            case "ID" -> "رُبط المستخدم بالتطبيق ووُضع في وحدته (مطابقة بمعرّف الوحدة).";
            case "NAME" -> "رُبط المستخدم بالتطبيق ووُضع في وحدته (مطابقة باسم الوحدة).";
            case "AMBIGUOUS" -> "رُبط المستخدم بالتطبيق، لكن اسم الوحدة يطابق أكثر من وحدة؛ لم يُوضع في وحدة. أضِف معرّف الوحدة أو ضَعه يدوياً.";
            default -> "رُبط المستخدم بالتطبيق، لكن لم تُطابق وحدة واحدة باسمها أو بمعرّفها؛ لم يُوضع في وحدة.";
        };
        return new ConnectResult(true, message, person.toString(), u.displayName(), u.employeeNumber(), u.username(), unitName, matchedBy);
    }

    private static String describe(DirectoryAuthenticator.DirectoryException e) {
        return switch (e.failure()) {
            case INVALID_CREDENTIALS -> "رفض الدليل اسم المستخدم أو كلمة المرور، أو لا يوجد سجل بهذا الاسم.";
            case AMBIGUOUS -> "اسم المستخدم يطابق أكثر من سجل في الدليل.";
            case TLS -> "رُفض الاتصال المؤمَّن: الشهادة غير موثوقة أو اسم الخادم لا يطابقها.";
            case NOT_CONFIGURED -> "إعدادات الدليل غير مكتملة، أو لا حساب خدمة ولا كلمة مرور للمستخدم للقراءة.";
            case UNAVAILABLE -> "تعذر الوصول إلى الدليل (العنوان، المنفذ أو الجدار الناري).";
        };
    }
}
