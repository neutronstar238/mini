#include <iostream>
struct S{int a;int b;S():b(2),a(1){}}; int main(){S s;std::cout<<s.a+s.b<<"\n";}
