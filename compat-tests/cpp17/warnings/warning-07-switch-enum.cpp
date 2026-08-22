#include <iostream>
enum class E{A,B}; int main(){E e=E::A;switch(e){case E::A:std::cout<<"A\n";break;}}
