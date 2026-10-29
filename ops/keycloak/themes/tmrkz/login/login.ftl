<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=!messagesPerField.existsError('username','password'); section>
    <#if section = "header">
        تسجيل الدخول المؤسسي
    <#elseif section = "form">
        <#assign invalid = messagesPerField.existsError('username','password')>
        <form id="kc-form-login" class="tm-form" action="${url.loginAction}" method="post" novalidate>
            <label class="tm-field" for="username">
                <span>اسم المستخدم في الدليل</span>
                <input id="username" name="username" type="text" dir="ltr" autocomplete="username" autofocus
                       value="${(login.username!'')}" <#if usernameEditDisabled??>disabled</#if>
                       <#if invalid>aria-invalid="true" aria-describedby="tm-error"</#if>/>
            </label>
            <label class="tm-field" for="password">
                <span>كلمة المرور</span>
                <span class="tm-password">
                    <input id="password" name="password" type="password" dir="ltr" autocomplete="current-password"
                           <#if invalid>aria-invalid="true" aria-describedby="tm-error"</#if>/>
                    <button type="button" class="tm-reveal" data-reveal="password" aria-controls="password" aria-pressed="false">إظهار</button>
                </span>
            </label>
            <#if invalid>
                <div id="tm-error" class="tm-alert tm-alert-error" role="alert" aria-live="polite">
                    ${kcSanitize(messagesPerField.getFirstError('username','password'))?no_esc}
                </div>
            </#if>
            <input type="hidden" id="id-hidden-input" name="credentialId" <#if auth.selectedCredential?has_content>value="${auth.selectedCredential}"</#if>/>
            <button class="tm-submit" name="login" id="kc-login" type="submit">دخول</button>
        </form>
    <#elseif section = "info">
        <p>يتحقق الدليل المؤسسي من كلمة المرور ولا يحفظها TMRKZ. تُمنح الصلاحيات من جهتك وفق انتمائك الوظيفي، لا بمجرد امتلاك حساب.</p>
    </#if>
</@layout.registrationLayout>
