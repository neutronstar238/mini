/* Java Checkpoint 1 A5: the twelve mandatory System.in compatibility cases. */
const source = body => `public class Main { public static void main(String[] args) throws Exception { ${body} } }`;

export const IO_CASES = [
  {
    name: 'scanner_ab', input: '2 3\n', expected: '5\n',
    source: 'import java.util.*; ' + source('Scanner s=new Scanner(System.in); System.out.println(s.nextInt()+s.nextInt());')
  },
  {
    name: 'scanner_until_eof', input: '1 2\n3 4', expected: '10\n',
    source: 'import java.util.*; ' + source('Scanner s=new Scanner(System.in); long x=0; while(s.hasNextLong()) x+=s.nextLong(); System.out.println(x);')
  },
  {
    name: 'bufferedreader_ab', input: '11 22\n', expected: '33\n',
    source: 'import java.io.*; import java.util.*; ' + source('BufferedReader r=new BufferedReader(new InputStreamReader(System.in)); StringTokenizer t=new StringTokenizer(r.readLine()); System.out.println(Integer.parseInt(t.nextToken())+Integer.parseInt(t.nextToken()));')
  },
  {
    name: 'bufferedreader_until_eof', input: 'alpha\nbeta', expected: '2\n',
    source: 'import java.io.*; ' + source('BufferedReader r=new BufferedReader(new InputStreamReader(System.in)); int n=0; while(r.readLine()!=null)n++; System.out.println(n);')
  },
  {
    name: 'stringtokenizer', input: '3 4 5\n', expected: '12\n',
    source: 'import java.io.*; import java.util.*; ' + source('StringTokenizer t=new StringTokenizer(new BufferedReader(new InputStreamReader(System.in)).readLine()); int n=0; while(t.hasMoreTokens())n+=Integer.parseInt(t.nextToken()); System.out.println(n);')
  },
  {
    name: 'bufferedinputstream_fastscanner', input: '9 8\n', expected: '17\n',
    source: 'import java.io.*; public class Main { static int next() throws Exception { int c,v=0; do c=System.in.read(); while(c<=32&&c>=0); while(c>32){v=v*10+c-48;c=System.in.read();} return v; } public static void main(String[] a)throws Exception{System.setIn(new BufferedInputStream(System.in));System.out.println(next()+next());}}'
  },
  {
    name: 'system_in_read', input: 'abc', expected: '97 98 99 -1\n',
    source: source('System.out.println(System.in.read()+" "+System.in.read()+" "+System.in.read()+" "+System.in.read());')
  },
  {
    name: 'empty_input', input: '', expected: '-1 0\n',
    source: source('System.out.println(System.in.read()+" "+System.in.available());')
  },
  {
    name: 'no_trailing_newline', input: 'hello', expected: 'hello|true\n',
    source: 'import java.io.*; ' + source('BufferedReader r=new BufferedReader(new InputStreamReader(System.in)); System.out.println(r.readLine()+"|"+(r.readLine()==null));')
  },
  {
    name: 'large_input_10000',
    input: Array.from({length: 10000}, (_, index) => index + 1).join(' ') + '\n',
    expected: '10000 50005000\n',
    source: 'import java.io.*; import java.util.*; ' + source('Scanner s=new Scanner(new BufferedInputStream(System.in)); int n=0; long sum=0; while(s.hasNextInt()){n++;sum+=s.nextInt();} System.out.println(n+" "+sum);')
  },
  {
    name: 'unicode', input: '你好 🌍\n', expected: '你好 🌍\n',
    source: 'import java.io.*; import java.nio.charset.*; ' + source('BufferedReader r=new BufferedReader(new InputStreamReader(System.in,StandardCharsets.UTF_8)); System.out.println(r.readLine());')
  },
  {
    name: 'multi_case', input: '3\n1 2\n10 20\n-5 7\n', expected: '3\n30\n2\n',
    source: 'import java.util.*; ' + source('Scanner s=new Scanner(System.in); for(int t=s.nextInt();t-->0;)System.out.println(s.nextInt()+s.nextInt());')
  }
];
