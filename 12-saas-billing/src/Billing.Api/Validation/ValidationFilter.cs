using Billing.Core.Errors;

namespace Billing.Api.Validation;

/// <summary>Runs the registered validator for the request body before the handler.</summary>
public sealed class ValidationFilter<T> : IEndpointFilter
    where T : class
{
    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var argument = context.Arguments.OfType<T>().FirstOrDefault()
            ?? throw DomainException.Validation(string.Empty, "A request body is required.");

        var validator = context.HttpContext.RequestServices.GetRequiredService<IValidator<T>>();
        var errors = new ValidationErrors();
        validator.Validate(argument, errors);
        if (errors.HasErrors)
        {
            throw DomainException.Validation(errors.Fields);
        }

        return await next(context);
    }
}

/// <summary>Endpoint builder helpers for request validation.</summary>
public static class ValidationExtensions
{
    /// <summary>Validates the body of type <typeparamref name="T"/> before the handler runs.</summary>
    public static RouteHandlerBuilder Validate<T>(this RouteHandlerBuilder builder)
        where T : class =>
        builder.AddEndpointFilter(new ValidationFilter<T>());

    /// <summary>Registers every validator in this assembly as a singleton.</summary>
    public static IServiceCollection AddValidators(this IServiceCollection services)
    {
        var types = typeof(ValidationExtensions).Assembly.GetTypes().Where(t => t is { IsClass: true, IsAbstract: false });
        foreach (var type in types)
        {
            var interfaces = type.GetInterfaces()
                .Where(i => i.IsGenericType && i.GetGenericTypeDefinition() == typeof(IValidator<>));
            foreach (var contract in interfaces)
            {
                services.AddSingleton(contract, type);
            }
        }

        return services;
    }
}
