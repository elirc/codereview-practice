using System.Text.Json;
using Billing.Core;
using Billing.Worker;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

var builder = Host.CreateApplicationBuilder(args);
var settings = BillingSettings.Load(key => builder.Configuration[key]);

builder.Logging.ClearProviders();
builder.Logging.AddJsonConsole(options =>
{
    options.IncludeScopes = true;
    options.UseUtcTimestamp = true;
    options.TimestampFormat = "yyyy-MM-dd'T'HH:mm:ss.fff'Z' ";
    options.JsonWriterOptions = new JsonWriterOptions { Indented = false };
});
builder.Logging.AddFilter("Microsoft.EntityFrameworkCore", LogLevel.Warning);

builder.Services.AddBillingCore(settings);
builder.Services.AddLoops(settings);

await builder.Build().RunAsync();
