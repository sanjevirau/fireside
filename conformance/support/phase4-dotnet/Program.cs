using System.Diagnostics;
using System.Text;
using System.Text.Json;
using FirebaseAdmin;
using FirebaseAdmin.Auth;
using Google.Api.Gax;
using Google.Apis.Auth.OAuth2;
using Google.Cloud.Firestore;
using Google.Cloud.Storage.V1;

var options = ParseArguments(args);
var projectId = Required(options, "project-id");
var authHost = Required(options, "auth-host");
var firestoreHost = Required(options, "firestore-host");
var storageHost = Required(options, "storage-host");
var outputPath = Path.GetFullPath(Required(options, "output"));

Environment.SetEnvironmentVariable("GCLOUD_PROJECT", projectId);
Environment.SetEnvironmentVariable("GOOGLE_CLOUD_PROJECT", projectId);
Environment.SetEnvironmentVariable("FIREBASE_AUTH_EMULATOR_HOST", authHost);
Environment.SetEnvironmentVariable("FIRESTORE_EMULATOR_HOST", firestoreHost);
Environment.SetEnvironmentVariable("STORAGE_EMULATOR_HOST", storageHost);
Environment.SetEnvironmentVariable("GOOGLE_APPLICATION_CREDENTIALS", null);

var runId = $"phase4-dotnet-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}-{Guid.NewGuid():N}";
var app = FirebaseApp.Create(new AppOptions
{
    Credential = GoogleCredential.FromAccessToken("owner"),
    ProjectId = projectId,
}, runId);
var auth = FirebaseAuth.GetAuth(app);
var firestore = new FirestoreDbBuilder
{
    ProjectId = projectId,
    EmulatorDetection = EmulatorDetection.EmulatorOnly,
}.Build();
var storage = new StorageClientBuilder
{
    BaseUri = $"http://{storageHost}/storage/v1/",
    UnauthenticatedAccess = true,
}.Build();

var authLatencies = new List<double>();
var createdUsers = new List<string>();
var documents = new List<DocumentReference>();
var objects = new List<(string Bucket, string Name)>();
try
{
    for (var index = 0; index < 10; index += 1)
    {
        var uid = $"{runId}-{index}";
        var email = $"{uid}@example.test";
        var timer = Stopwatch.StartNew();
        await auth.CreateUserAsync(new UserRecordArgs
        {
            Uid = uid,
            Email = email,
            EmailVerified = true,
            DisplayName = $".NET Admin 火🔥 {index}",
        });
        createdUsers.Add(uid);
        var byId = await auth.GetUserAsync(uid);
        var byEmail = await auth.GetUserByEmailAsync(email);
        await auth.SetCustomUserClaimsAsync(uid, new Dictionary<string, object>
        {
            ["phase"] = 4,
        });
        var withClaims = await auth.GetUserAsync(uid);
        if (byId.Email != email || byEmail.Uid != uid ||
            !withClaims.CustomClaims.TryGetValue("phase", out var phase) ||
            Convert.ToInt32(phase) != 4)
        {
            throw new InvalidOperationException($".NET Admin Auth round trip diverged for {uid}");
        }
        timer.Stop();
        authLatencies.Add(timer.Elapsed.TotalMilliseconds);
    }

    var listedUsers = new List<string>();
    var users = auth.ListUsersAsync(new ListUsersOptions { PageSize = 1_000 });
    await foreach (var user in users)
    {
        listedUsers.Add(user.Uid);
    }
    if (!listedUsers.Contains($"{runId}-0", StringComparer.Ordinal))
    {
        throw new InvalidOperationException(".NET Admin Auth pagination omitted the synthetic user");
    }

    var document = firestore.Document($"_firesidePhase4/{runId}");
    documents.Add(document);
    await document.SetAsync(new Dictionary<string, object>
    {
        ["client"] = "dotnet-admin",
        ["runId"] = runId,
        ["unicode"] = "火🔥",
    });
    var snapshot = await document.GetSnapshotAsync();
    if (!snapshot.Exists || snapshot.GetValue<string>("unicode") != "火🔥")
    {
        throw new InvalidOperationException(".NET Firestore round trip diverged");
    }

    var storageLatencies = new List<double>();
    var buckets = new[] { $"{projectId}.appspot.com", "assets-local.twodart.com" };
    foreach (var bucket in buckets)
    {
        for (var index = 0; index < 5; index += 1)
        {
            var name = $"_firesidePhase4/{runId}/{index}-火🔥.txt";
            var bytes = Encoding.UTF8.GetBytes($".NET Admin {bucket} {index} 火🔥\n");
            var timer = Stopwatch.StartNew();
            using (var input = new MemoryStream(bytes))
            {
                await storage.UploadObjectAsync(
                    bucket,
                    name,
                    "text/plain; charset=utf-8",
                    input,
                    new UploadObjectOptions
                    {
                        UserProject = projectId,
                    });
            }
            objects.Add((bucket, name));
            using var downloaded = new MemoryStream();
            await storage.DownloadObjectAsync(bucket, name, downloaded);
            var metadata = await storage.GetObjectAsync(bucket, name);
            var listed = storage.ListObjectsAsync(bucket, name);
            var listedNames = new List<string>();
            await foreach (var item in listed)
            {
                listedNames.Add(item.Name);
            }
            if (!downloaded.ToArray().SequenceEqual(bytes) ||
                metadata.Name != name ||
                listedNames.Count != 1 ||
                listedNames[0] != name)
            {
                throw new InvalidOperationException($".NET Storage round trip diverged for {bucket}/{name}");
            }
            timer.Stop();
            storageLatencies.Add(timer.Elapsed.TotalMilliseconds);
        }
    }

    var evidence = new
    {
        schemaVersion = 1,
        passed = true,
        client = "Twodart .NET Firebase and Google Cloud SDKs",
        projectId,
        packageVersions = new
        {
            firebaseAdmin = "3.4.0",
            googleCloudFirestore = "4.0.0",
            googleCloudStorage = "4.13.0",
        },
        auth = Summarize(authLatencies),
        firestore = new { passed = true, unicode = "火🔥" },
        storage = new { passed = true, buckets, operations = Summarize(storageLatencies) },
    };
    Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);
    await File.WriteAllTextAsync(
        outputPath,
        JsonSerializer.Serialize(evidence, new JsonSerializerOptions { WriteIndented = true }) + "\n");
}
finally
{
    foreach (var (bucket, name) in objects.AsEnumerable().Reverse())
    {
        try { await storage.DeleteObjectAsync(bucket, name); } catch { }
    }
    foreach (var document in documents.AsEnumerable().Reverse())
    {
        try { await document.DeleteAsync(); } catch { }
    }
    foreach (var uid in createdUsers.AsEnumerable().Reverse())
    {
        try { await auth.DeleteUserAsync(uid); } catch { }
    }
    app.Delete();
}

static object Summarize(IReadOnlyCollection<double> values)
{
    if (values.Count == 0) throw new InvalidOperationException("cannot summarize zero samples");
    var sorted = values.Order().ToArray();
    return new
    {
        p50Milliseconds = Percentile(sorted, 0.50),
        p95Milliseconds = Percentile(sorted, 0.95),
        p99Milliseconds = Percentile(sorted, 0.99),
        samples = sorted.Length,
    };
}

static double Percentile(IReadOnlyList<double> sorted, double quantile)
{
    var index = Math.Min(sorted.Count - 1, Math.Max(0, (int)Math.Ceiling(sorted.Count * quantile) - 1));
    return sorted[index];
}

static Dictionary<string, string> ParseArguments(IReadOnlyList<string> values)
{
    if (values.Count % 2 != 0) throw new ArgumentException("arguments must be --key value pairs");
    var parsed = new Dictionary<string, string>(StringComparer.Ordinal);
    for (var index = 0; index < values.Count; index += 2)
    {
        var key = values[index];
        if (!key.StartsWith("--", StringComparison.Ordinal))
        {
            throw new ArgumentException($"invalid argument {key}");
        }
        parsed[key[2..]] = values[index + 1];
    }
    return parsed;
}

static string Required(IReadOnlyDictionary<string, string> values, string key)
{
    if (!values.TryGetValue(key, out var value) || string.IsNullOrWhiteSpace(value))
    {
        throw new ArgumentException($"--{key} is required");
    }
    return value;
}
