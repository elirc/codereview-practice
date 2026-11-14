using System.Globalization;
using Billing.Api.Commands;
using Billing.Api.Infrastructure;
using Billing.Core;

var command = args.Length > 0 && !args[0].StartsWith('-') ? args[0] : null;
var hostArgs = command is null ? args : args[1..];

var builder = WebApplication.CreateBuilder(hostArgs);
var settings = BillingSettings.Load(key => builder.Configuration[key]);

builder.Logging.AddBillingLogging();
builder.Services.AddBillingCore(settings);
builder.Services.AddBillingApi();

var app = builder.Build();

switch (command)
{
    case null:
        break;
    case "migrate":
        Environment.ExitCode = await MigrateCommand.RunAsync(app.Services);
        return;
    default:
        Console.Error.WriteLine($"Unknown command \"{command}\".");
        Environment.ExitCode = 2;
        return;
}

app.UseBillingApi();
app.Urls.Add(string.Create(CultureInfo.InvariantCulture, $"http://0.0.0.0:{settings.Port}"));
await app.RunAsync();

/// <summary>Entry point of the HTTP API; also runs the migrate and seed commands.</summary>
public partial class Program;
