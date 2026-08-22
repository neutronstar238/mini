#include <iostream>
#include <limits>
int main(){volatile int x=std::numeric_limits<int>::max();x=x+1;std::cout<<x<<"\n";}
