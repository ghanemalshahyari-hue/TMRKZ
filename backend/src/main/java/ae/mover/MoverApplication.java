package ae.mover;

import java.util.TimeZone;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class MoverApplication {

    public static void main(String[] args) {
        // Server time is the reference and is always handled in UTC; display zone is an organisation setting.
        TimeZone.setDefault(TimeZone.getTimeZone("UTC"));
        SpringApplication.run(MoverApplication.class, args);
    }
}
