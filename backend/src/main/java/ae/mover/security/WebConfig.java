package ae.mover.security;

import java.util.List;

import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.MethodParameter;
import org.springframework.web.bind.support.WebDataBinderFactory;
import org.springframework.web.context.request.NativeWebRequest;
import org.springframework.web.context.request.RequestAttributes;
import org.springframework.web.method.support.HandlerMethodArgumentResolver;
import org.springframework.web.method.support.ModelAndViewContainer;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import ae.mover.common.ApiException;
import ae.mover.common.ErrorCode;

@Configuration
@EnableConfigurationProperties({SecurityProperties.class, OidcProperties.class})
public class WebConfig implements WebMvcConfigurer {

    @Override
    public void addArgumentResolvers(List<HandlerMethodArgumentResolver> resolvers) {
        resolvers.add(new HandlerMethodArgumentResolver() {
            @Override
            public boolean supportsParameter(MethodParameter parameter) {
                return parameter.getParameterType().equals(Actor.class);
            }

            @Override
            public Object resolveArgument(MethodParameter parameter, ModelAndViewContainer mav, NativeWebRequest request,
                                          WebDataBinderFactory binder) {
                Object actor = request.getAttribute(SessionFilter.ACTOR_ATTRIBUTE, RequestAttributes.SCOPE_REQUEST);
                if (actor == null) {
                    throw new ApiException(ErrorCode.UNAUTHENTICATED, "انتهت الجلسة أو لم يتم تسجيل الدخول.");
                }
                return actor;
            }
        });
    }
}
