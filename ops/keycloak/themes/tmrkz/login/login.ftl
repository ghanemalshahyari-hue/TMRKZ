<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=!messagesPerField.existsError('username','password'); section>
    <#if section = "header">
        المواقع · المرافق · الإجراءات الإدارية
    <#elseif section = "form">
        <#assign invalid = messagesPerField.existsError('username','password')>
        <#if invalid>
            <div class="tm-alert tm-alert-error" id="tm-error" role="alert">
                <span class="tm-alert-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="10" fill="currentColor" opacity=".16"/><path d="M12 7v6m0 3.5v.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></span>
                <span>${kcSanitize(messagesPerField.getFirstError('username','password'))?no_esc}</span>
            </div>
        </#if>
        <form id="kc-form-login" class="tm-form" action="${url.loginAction}" method="post" novalidate>
            <div class="tm-field">
                <label class="tm-sr" for="username">اسم المستخدم</label>
                <input id="username" name="username" type="text" placeholder="اسم المستخدم" autocomplete="username" autofocus
                       value="${(login.username!'')}" <#if usernameEditDisabled??>disabled</#if>
                       <#if invalid>aria-invalid="true" aria-describedby="tm-error"</#if>/>
                <span class="tm-glyph" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="8" r="4" fill="currentColor"/><path d="M4 20c1.2-4 4.4-6 8-6s6.8 2 8 6" fill="currentColor"/></svg></span>
            </div>
            <div class="tm-field tm-with-reveal">
                <label class="tm-sr" for="password">كلمة المرور</label>
                <input id="password" name="password" type="password" placeholder="كلمة المرور" autocomplete="current-password"
                       <#if invalid>aria-invalid="true" aria-describedby="tm-error"</#if>/>
                <span class="tm-glyph" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16"><rect x="5" y="10" width="14" height="10" rx="2.2" fill="currentColor"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10" fill="none" stroke="currentColor" stroke-width="2"/></svg></span>
                <button type="button" class="tm-reveal" data-reveal="password" aria-controls="password" aria-pressed="false"
                        aria-label="إظهار كلمة المرور أو إخفاؤها">
                    <svg class="tm-eye" viewBox="0 0 24 24" width="17" height="17"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z" fill="none" stroke="currentColor" stroke-width="1.9"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>
                    <svg class="tm-eye-off" viewBox="0 0 24 24" width="17" height="17"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M4 4l16 16" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>
                </button>
            </div>
            <input type="hidden" id="id-hidden-input" name="credentialId" <#if auth.selectedCredential?has_content>value="${auth.selectedCredential}"</#if>/>
            <button class="tm-submit" name="login" id="kc-login" type="submit">
                <span class="tm-submit-label">تسجيل الدخول</span>
                <span class="tm-spinner" aria-hidden="true"></span>
                <svg class="tm-arrow" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M19 12H5m6-6-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
            <p class="tm-help">يتحقق الدليل المؤسسي من كلمة المرور ولا يحفظها النظام.</p>
        </form>
    <#elseif section = "info">
        بيئة تشغيل داخلية معزولة · TMRKZ
    </#if>
</@layout.registrationLayout>
