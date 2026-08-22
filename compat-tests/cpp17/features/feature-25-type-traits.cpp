#include <iostream>
#include <type_traits>
int main(){ std::cout<<std::boolalpha<<std::is_same_v<std::decay_t<const int&>,int><<"\n"; }
