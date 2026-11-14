package ledger.config

import com.fasterxml.jackson.databind.MapperFeature
import com.fasterxml.jackson.databind.cfg.CoercionAction
import com.fasterxml.jackson.databind.cfg.CoercionInputShape
import com.fasterxml.jackson.databind.type.LogicalType
import org.springframework.boot.autoconfigure.jackson.Jackson2ObjectMapperBuilderCustomizer
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import java.security.SecureRandom
import java.time.Clock

@Configuration
class AppConfig {
    @Bean
    fun clock(): Clock = Clock.systemUTC()

    @Bean
    fun secureRandom(): SecureRandom = SecureRandom()

    /** Makes JSON scalars strict: numbers stay numbers, strings stay strings, booleans stay booleans. */
    @Bean
    fun strictScalars(): Jackson2ObjectMapperBuilderCustomizer =
        Jackson2ObjectMapperBuilderCustomizer { builder ->
            builder.featuresToDisable(MapperFeature.ALLOW_COERCION_OF_SCALARS)
            builder.postConfigurer { mapper ->
                mapper.coercionConfigFor(LogicalType.Integer)
                    .setCoercion(CoercionInputShape.String, CoercionAction.Fail)
                    .setCoercion(CoercionInputShape.Float, CoercionAction.Fail)
                    .setCoercion(CoercionInputShape.Boolean, CoercionAction.Fail)
                mapper.coercionConfigFor(LogicalType.Boolean)
                    .setCoercion(CoercionInputShape.String, CoercionAction.Fail)
                    .setCoercion(CoercionInputShape.Integer, CoercionAction.Fail)
                mapper.coercionConfigFor(LogicalType.Textual)
                    .setCoercion(CoercionInputShape.Integer, CoercionAction.Fail)
                    .setCoercion(CoercionInputShape.Float, CoercionAction.Fail)
                    .setCoercion(CoercionInputShape.Boolean, CoercionAction.Fail)
            }
        }
}
