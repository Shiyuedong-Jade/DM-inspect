/*
 * DmBridge -- Dameng DM8 JDBC bridge.
 * ---------------------------------------------------------------------------
 * Started by the Node.js inspection service. It talks back to the host process
 * over a 127.0.0.1 loopback TCP socket instead of stdio pipes, because:
 *   1) the Windows console default codepage (GBK) corrupts Chinese data;
 *   2) some restricted environments cannot create named pipes.
 * All fields are Base64(UTF-8) encoded, so encoding never matters.
 *
 * NOTE: this source file is intentionally 100% ASCII. In "source-file mode"
 * (JDK 9+ single-file launch) javac reads the source with the *platform*
 * default charset and the launcher rejects the -encoding option, so any
 * non-ASCII literal would be mangled on a Chinese Windows box. Chinese
 * user-facing strings are therefore written as unicode escapes. (Never write
 * that escape prefix inside a comment: Java expands it even in comments.)
 *
 * Launch (Java 11+, no compile step):
 *     java -cp DmJdbcDriver18.jar DmBridge.java <port> <token>
 * Fallback (Java 8), compile first then run:
 *     javac -encoding UTF-8 -cp <jar> -d classes DmBridge.java
 *     java -cp <jar>;<classes> DmBridge <port> <token>
 *
 * Protocol: line based. Fields are separated by a single space and every
 * field payload is Base64(UTF-8). '~' means SQL NULL.
 *   host -> bridge:
 *     CONNECT <b64 url> <b64 user> <b64 password> <queryTimeoutSec> <loginTimeoutSec> [<b64 schema>]
 *     QUERY   <id> <maxRows> <b64 sql>
 *     PING
 *     QUIT
 *   bridge -> host:
 *     READY <b64 token>
 *     CONNECTED <b64 "product version">
 *     COLS <id> <b64col|b64col|...>
 *     ROW  <id> <b64val|b64val|...>
 *     END  <id> <rowCount>
 *     ERR  <id|-> <b64 message>
 *     PONG
 *     BYE
 */

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.math.BigDecimal;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.sql.Blob;
import java.sql.Clob;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.Statement;
import java.util.Base64;
import java.util.Properties;

public class DmBridge {

    /** Max characters taken from a single column value. */
    private static final int MAX_VALUE_CHARS = 4000;

    /** \u5B57\u8282 = "bytes", \u5B57\u7B26 = "characters" */
    private static final String U_BYTES = "\u5B57\u8282";
    private static final String U_CHARS = "\u5B57\u7B26";
    private static final String U_TOTAL = "\u5171"; // "total"
    private static final String U_NOT_CONNECTED =
            "\u5C1A\u672A\u5EFA\u7ACB\u6570\u636E\u5E93\u8FDE\u63A5"; // "no database connection"
    private static final String U_READ_FAILED =
            "\u8BFB\u53D6\u5931\u8D25"; // "read failed"

    private static BufferedReader in;
    private static BufferedWriter out;
    private static Connection conn = null;
    private static int queryTimeoutSec = 60;
    private static final Object WRITE_LOCK = new Object();

    public static void main(String[] args) throws Exception {
        if (args.length < 2) {
            System.err.println("usage: DmBridge <port> <token>");
            System.exit(2);
        }
        final int port = Integer.parseInt(args[0].trim());
        final String token = args[1];

        // Load the Dameng driver up front. If the class name differs the SPI
        // auto-registration still applies, so a failure here is not fatal.
        try {
            Class.forName("dm.jdbc.driver.DmDriver");
        } catch (Throwable ignore) {
            // rely on DriverManager SPI
        }

        Socket sock = new Socket();
        sock.connect(new InetSocketAddress("127.0.0.1", port), 15000);
        sock.setTcpNoDelay(true);
        sock.setKeepAlive(true);

        in = new BufferedReader(new InputStreamReader(sock.getInputStream(), StandardCharsets.UTF_8));
        out = new BufferedWriter(new OutputStreamWriter(sock.getOutputStream(), StandardCharsets.UTF_8));

        send("READY " + b64(token));

        String line;
        while ((line = in.readLine()) != null) {
            line = line.trim();
            if (line.isEmpty()) {
                continue;
            }
            String[] p = line.split(" ", -1);
            String cmd = p[0].toUpperCase();
            try {
                if ("CONNECT".equals(cmd)) {
                    doConnect(p);
                } else if ("QUERY".equals(cmd)) {
                    doQuery(p);
                } else if ("PING".equals(cmd)) {
                    send("PONG");
                } else if ("QUIT".equals(cmd)) {
                    send("BYE");
                    break;
                } else {
                    send("ERR - " + b64("unknown command: " + cmd));
                }
            } catch (Throwable t) {
                String id = p.length > 1 ? p[1] : "-";
                send("ERR " + id + " " + b64(describe(t)));
            }
        }

        closeQuietly();
        System.exit(0);
    }

    // ------------------------------------------------------------- commands

    private static void doConnect(String[] p) throws Exception {
        if (p.length < 5) {
            throw new IllegalArgumentException("CONNECT needs at least 5 fields");
        }
        String url = unb64(p[1]);
        String user = unb64(p[2]);
        String password = unb64(p[3]);
        queryTimeoutSec = Integer.parseInt(p[4].trim());
        int loginTimeoutSec = (p.length > 5 && !p[5].isEmpty()) ? Integer.parseInt(p[5].trim()) : 15;
        String schema = (p.length > 6 && !p[6].isEmpty()) ? unb64(p[6]) : null;

        closeQuietly();

        // Avoid very long driver-internal retries when the target is unreachable.
        try {
            DriverManager.setLoginTimeout(Math.max(3, loginTimeoutSec));
        } catch (Throwable ignore) {
            // ignore
        }

        Properties props = new Properties();
        props.setProperty("user", user);
        props.setProperty("password", password);
        if (schema != null && !schema.isEmpty()) {
            props.setProperty("schema", schema);
        }

        conn = DriverManager.getConnection(url, props);
        conn.setAutoCommit(true);

        String ver;
        try {
            DatabaseMetaData md = conn.getMetaData();
            ver = md.getDatabaseProductName() + " " + md.getDatabaseProductVersion();
        } catch (Throwable t) {
            ver = "unknown";
        }
        send("CONNECTED " + b64(ver));
    }

    private static void doQuery(String[] p) throws Exception {
        if (p.length < 4) {
            throw new IllegalArgumentException("QUERY needs at least 4 fields");
        }
        String id = p[1];
        int maxRows = Integer.parseInt(p[2].trim());
        String sql = unb64(p[3]);

        if (conn == null || conn.isClosed()) {
            send("ERR " + id + " " + b64(U_NOT_CONNECTED + " (not connected)"));
            return;
        }

        Statement st = null;
        ResultSet rs = null;
        try {
            st = conn.createStatement();
            if (queryTimeoutSec > 0) {
                try {
                    st.setQueryTimeout(queryTimeoutSec);
                } catch (Throwable ignore) {
                    // not supported by some drivers, ignore
                }
            }
            if (maxRows > 0) {
                try {
                    st.setMaxRows(maxRows);
                } catch (Throwable ignore) {
                    // ignore
                }
            }

            boolean hasResultSet = st.execute(sql);
            if (!hasResultSet) {
                send("COLS " + id + " " + b64("affected_rows"));
                send("ROW " + id + " " + b64(String.valueOf(st.getUpdateCount())));
                send("END " + id + " 1");
                return;
            }

            rs = st.getResultSet();
            ResultSetMetaData m = rs.getMetaData();
            int n = m.getColumnCount();

            StringBuilder sb = new StringBuilder();
            for (int i = 1; i <= n; i++) {
                if (i > 1) {
                    sb.append('|');
                }
                String label = null;
                try {
                    label = m.getColumnLabel(i);
                } catch (Throwable ignore) {
                    // ignore
                }
                if (label == null || label.isEmpty()) {
                    label = m.getColumnName(i);
                }
                sb.append(b64(label));
            }
            send("COLS " + id + " " + sb);

            int count = 0;
            while (rs.next()) {
                sb.setLength(0);
                for (int i = 1; i <= n; i++) {
                    if (i > 1) {
                        sb.append('|');
                    }
                    sb.append(encodeValue(rs, i));
                }
                send("ROW " + id + " " + sb);
                count++;
            }
            send("END " + id + " " + count);
        } finally {
            if (rs != null) {
                try {
                    rs.close();
                } catch (Throwable ignore) {
                    // ignore
                }
            }
            if (st != null) {
                try {
                    st.close();
                } catch (Throwable ignore) {
                    // ignore
                }
            }
        }
    }

    // -------------------------------------------------------- value encoding

    private static String encodeValue(ResultSet rs, int idx) {
        try {
            Object o = rs.getObject(idx);
            if (o == null || rs.wasNull()) {
                return "~";
            }
            String s;
            if (o instanceof Clob) {
                Clob c = (Clob) o;
                long len = c.length();
                int take = (int) Math.min(len, MAX_VALUE_CHARS);
                s = c.getSubString(1, take);
                if (len > take) {
                    s = s + "...(" + U_TOTAL + " " + len + " " + U_CHARS + ")";
                }
            } else if (o instanceof Blob) {
                s = "(BLOB " + ((Blob) o).length() + " " + U_BYTES + ")";
            } else if (o instanceof byte[]) {
                s = "(BINARY " + ((byte[]) o).length + " " + U_BYTES + ")";
            } else if (o instanceof BigDecimal) {
                s = ((BigDecimal) o).toPlainString();
            } else {
                s = String.valueOf(o);
            }
            if (s.length() > MAX_VALUE_CHARS) {
                s = s.substring(0, MAX_VALUE_CHARS) + "...";
            }
            return b64(s);
        } catch (Throwable t) {
            return b64("<" + U_READ_FAILED + ": " + t.getMessage() + ">");
        }
    }

    // ---------------------------------------------------------------- utils

    private static void send(String line) {
        synchronized (WRITE_LOCK) {
            try {
                out.write(line);
                out.write('\n');
                out.flush();
            } catch (Throwable t) {
                System.err.println("bridge write failed: " + t);
                closeQuietly();
                System.exit(0);
            }
        }
    }

    private static void closeQuietly() {
        if (conn != null) {
            try {
                conn.close();
            } catch (Throwable ignore) {
                // ignore
            }
            conn = null;
        }
    }

    private static String describe(Throwable t) {
        StringBuilder sb = new StringBuilder();
        Throwable cur = t;
        int depth = 0;
        while (cur != null && depth < 4) {
            if (depth > 0) {
                sb.append(" <- ");
            }
            sb.append(cur.getClass().getSimpleName());
            if (cur.getMessage() != null) {
                sb.append(": ").append(cur.getMessage().replace('\n', ' ').replace('\r', ' '));
            }
            cur = cur.getCause();
            depth++;
        }
        return sb.toString();
    }

    private static String b64(String s) {
        if (s == null) {
            return "";
        }
        return Base64.getEncoder().encodeToString(s.getBytes(StandardCharsets.UTF_8));
    }

    private static String unb64(String s) {
        if (s == null || s.isEmpty()) {
            return "";
        }
        return new String(Base64.getDecoder().decode(s), StandardCharsets.UTF_8);
    }
}
