package ae.mover.attachments;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/** Local content-addressed file storage on the mounted data volume (no external object store required). */
@Component
public class FileStore {

    private final Path root;

    public FileStore(@Value("${mover.storage.root}") String root) {
        this.root = Path.of(root).toAbsolutePath().normalize();
        try {
            Files.createDirectories(this.root.resolve("attachments"));
            Files.createDirectories(this.root.resolve("exports"));
            Files.createDirectories(this.root.resolve("tmp"));
        } catch (IOException e) {
            throw new UncheckedIOException("Cannot initialise storage at " + this.root, e);
        }
    }

    public String putAttachment(byte[] content, String sha256) {
        String key = "attachments/" + sha256.substring(0, 2) + "/" + sha256.substring(2, 4) + "/" + sha256;
        write(key, content);
        return key;
    }

    public void write(String key, byte[] content) {
        Path target = resolve(key);
        if (Files.exists(target)) {
            return;
        }
        try {
            Files.createDirectories(target.getParent());
            Path tmp = Files.createTempFile(root.resolve("tmp"), "upload", ".part");
            Files.write(tmp, content);
            Files.move(tmp, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    public InputStream open(String key) throws IOException {
        return Files.newInputStream(resolve(key));
    }

    public byte[] read(String key) {
        try {
            return Files.readAllBytes(resolve(key));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private Path resolve(String key) {
        Path p = root.resolve(key).normalize();
        if (!p.startsWith(root)) {
            throw new IllegalArgumentException("Invalid storage key");
        }
        return p;
    }
}
