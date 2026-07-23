// A minimal HTTP service on HttpListener — the smallest repo that exercises ORCA's .NET
// recipe: detect the .csproj, `dotnet publish`, run the dll under the ASP.NET runtime
// image. No external packages, so the build is hermetic.
using System.Net;
using System.Text;

var port = Environment.GetEnvironmentVariable("PORT") ?? "8080";
var listener = new HttpListener();
listener.Prefixes.Add($"http://*:{port}/");
listener.Start();
Console.WriteLine($"listening on :{port}");

while (true)
{
    var context = listener.GetContext();
    var body = Encoding.UTF8.GetBytes("{\"status\":\"ok\",\"service\":\"orca-dotnet-sample\"}");
    context.Response.ContentType = "application/json";
    context.Response.ContentLength64 = body.Length;
    context.Response.OutputStream.Write(body, 0, body.Length);
    context.Response.OutputStream.Close();
}
